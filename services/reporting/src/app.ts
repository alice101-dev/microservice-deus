import { authentication, requireOrganization, type Verifier } from "@deus/auth";
import type { AccountRef, Balances, ProfileRef } from "@deus/clients";
import type { BaseConfig } from "@deus/config";
import { type Database, withTenant } from "@deus/db";
import { NotFoundError, UnprocessableError } from "@deus/errors";
import { createService } from "@deus/http";
import type { Logger } from "@deus/logger";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";
import { type Statement, type schema, statements } from "./schema";
import { balanceSheet, dayBefore, fiscalYearStart, incomeStatement, netIncome } from "./statements";

export interface ReportingContext {
  config: BaseConfig;
  logger: Logger;
  db: Database<typeof schema>;
  verify: Verifier;
  chart: (organizationId: string) => Promise<AccountRef[]>;
  balances: Balances;
  profile: (organizationId: string) => Promise<ProfileRef | null>;
  readiness?: Array<() => Promise<void>>;
}

const Kind = t.Union([t.Literal("income-statement"), t.Literal("balance-sheet")]);
const Period = t.Object({ from: t.String({ format: "date" }), to: t.String({ format: "date" }) });
const AsOf = t.Object({ asOf: t.String({ format: "date" }) });
const StatementSummary = t.Object({
  id: t.String(),
  kind: Kind,
  from: t.Nullable(t.String()),
  to: t.String(),
  createdAt: t.String(),
});
const summary = (row: Statement) => ({
  id: row.id,
  kind: row.kind,
  from: row.periodFrom,
  to: row.periodTo,
  createdAt: row.createdAt.toISOString(),
});

export function createApp(context: ReportingContext) {
  const { db } = context;

  const buildIncomeStatement = async (organizationId: string, from: string, to: string) => {
    if (from > to) throw new UnprocessableError("The period starts after it ends");
    const [chart, balances] = await Promise.all([
      context.chart(organizationId),
      context.balances(organizationId, { from, to }),
    ]);
    return incomeStatement(chart, balances, { from, to });
  };

  const buildBalanceSheet = async (organizationId: string, asOf: string) => {
    const profile = await context.profile(organizationId);
    const yearStart = fiscalYearStart(asOf, profile?.fiscalYearStartMonth ?? 1);
    const [chart, balances, prior, current] = await Promise.all([
      context.chart(organizationId),
      context.balances(organizationId, { to: asOf }),
      context.balances(organizationId, { to: dayBefore(yearStart) }),
      context.balances(organizationId, { from: yearStart, to: asOf }),
    ]);
    return balanceSheet(
      chart,
      balances,
      { priorYears: netIncome(chart, prior), currentYear: netIncome(chart, current) },
      asOf,
    );
  };

  return createService({ config: context.config, logger: context.logger, readiness: context.readiness }).group(
    "/api/reporting",
    (api) =>
      api
        .use(authentication(context.verify))
        .get(
          "/income-statement",
          ({ principal, query }) => buildIncomeStatement(requireOrganization(principal), query.from, query.to),
          { query: Period, detail: { summary: "Revenue, expenses and net income over a period (laba rugi)" } },
        )
        .get(
          "/balance-sheet",
          ({ principal, query }) => buildBalanceSheet(requireOrganization(principal), query.asOf),
          {
            query: AsOf,
            detail: {
              summary:
                "Assets, liabilities and equity on a date (neraca), with the earnings not yet closed into equity",
            },
          },
        )
        .post(
          "/statements",
          async ({ principal, body, set }) => {
            const organizationId = requireOrganization(principal);
            const data =
              body.kind === "income-statement"
                ? await buildIncomeStatement(organizationId, body.from ?? body.to, body.to)
                : await buildBalanceSheet(organizationId, body.to);
            const [row] = await withTenant(db, organizationId, (tx) =>
              tx
                .insert(statements)
                .values({
                  organizationId,
                  kind: body.kind,
                  periodFrom: body.kind === "income-statement" ? (body.from ?? body.to) : null,
                  periodTo: body.to,
                  data,
                  createdBy: principal.userId,
                })
                .returning(),
            );
            set.status = 201;
            return { ...summary(row as Statement), data };
          },
          {
            body: t.Object({
              kind: Kind,
              from: t.Optional(t.String({ format: "date" })),
              to: t.String({ format: "date" }),
            }),
            detail: { summary: "Generate a statement and keep it as a snapshot" },
          },
        )
        .get(
          "/statements",
          async ({ principal, query }) => {
            const rows = await withTenant(db, requireOrganization(principal), (tx) =>
              tx
                .select()
                .from(statements)
                .where(and(query.kind ? eq(statements.kind, query.kind) : undefined))
                .orderBy(desc(statements.periodTo), desc(statements.createdAt))
                .limit(200),
            );
            return rows.map(summary);
          },
          {
            query: t.Object({ kind: t.Optional(Kind) }),
            response: t.Array(StatementSummary),
            detail: { summary: "Statement snapshots, newest period first" },
          },
        )
        .get(
          "/statements/:id",
          async ({ principal, params }) => {
            const [row] = await withTenant(db, requireOrganization(principal), (tx) =>
              tx.select().from(statements).where(eq(statements.id, params.id)),
            );
            if (!row) throw new NotFoundError("The statement does not exist");
            return { ...summary(row), data: row.data };
          },
          { params: t.Object({ id: t.String({ format: "uuid" }) }), detail: { summary: "One statement snapshot" } },
        ),
  );
}
