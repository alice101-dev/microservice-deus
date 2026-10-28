import { authentication, requireOrganization, type Verifier } from "@deus/auth";
import type { AccountRef, AccountsByCode, Balances } from "@deus/clients";
import type { BaseConfig } from "@deus/config";
import { type Database, withTenant } from "@deus/db";
import { today } from "@deus/documents";
import { ConflictError, NotFoundError, UnprocessableError } from "@deus/errors";
import { createService } from "@deus/http";
import type { Logger } from "@deus/logger";
import { enqueue } from "@deus/outbox";
import { desc, eq } from "drizzle-orm";
import { t } from "elysia";
import { type schema, type VatReturn, vatReturns } from "./schema";
import { calculate, periodEnd, settlementJournal, type VatAccounts } from "./vat";

export const TOPICS = { journal: "ledger.journal" } as const;

export interface TaxContext {
  config: BaseConfig;
  logger: Logger;
  db: Database<typeof schema>;
  verify: Verifier;
  accountsByCode: AccountsByCode;
  balances: Balances;
  vatOutputAccountCode: string;
  vatInputAccountCode: string;
  taxPayableAccountCode: string;
  today?: () => string;
  readiness?: Array<() => Promise<void>>;
}

const Period = t.String({ pattern: "^[0-9]{4}-(0[1-9]|1[0-2])$" });
const ReturnView = t.Object({
  id: t.String(),
  period: t.String(),
  outputVat: t.String(),
  inputVat: t.String(),
  payable: t.String(),
  carriedForward: t.String(),
  status: t.Union([t.Literal("draft"), t.Literal("filed")]),
  calculatedAt: t.String(),
  filedAt: t.Nullable(t.String()),
});
const view = (row: VatReturn) => ({
  id: row.id,
  period: row.period,
  outputVat: row.outputVat,
  inputVat: row.inputVat,
  payable: row.payable,
  carriedForward: row.carriedForward,
  status: row.status,
  calculatedAt: row.calculatedAt.toISOString(),
  filedAt: row.filedAt ? row.filedAt.toISOString() : null,
});

export function createApp(context: TaxContext) {
  const { db } = context;
  const now = context.today ?? (() => today());

  const vatAccounts = async (organizationId: string): Promise<VatAccounts> => {
    const codes = [context.vatOutputAccountCode, context.vatInputAccountCode, context.taxPayableAccountCode];
    const found = await context.accountsByCode(codes, organizationId);
    const pick = (code: string, type: AccountRef["type"]) => {
      const account = found.find((entry) => entry.code === code);
      if (!account?.active || !account.postable || account.type !== type) {
        throw new UnprocessableError(`Account ${code} must exist as an active ${type} account without sub-accounts`, {
          code,
        });
      }
      return account.id;
    };
    return {
      output: pick(context.vatOutputAccountCode, "liability"),
      input: pick(context.vatInputAccountCode, "asset"),
      payable: pick(context.taxPayableAccountCode, "liability"),
    };
  };

  const compute = async (organizationId: string, period: string) => {
    const accounts = await vatAccounts(organizationId);
    const balances = await context.balances(organizationId, {
      to: periodEnd(period),
      accountId: [accounts.output, accounts.input],
    });
    return { accounts, amounts: calculate(balances, accounts) };
  };

  return createService({ config: context.config, logger: context.logger, readiness: context.readiness }).group(
    "/api/tax",
    (api) =>
      api
        .use(authentication(context.verify))
        .post(
          "/vat-returns",
          async ({ principal, body, set }) => {
            const organizationId = requireOrganization(principal);
            const { amounts } = await compute(organizationId, body.period);
            const saved = await withTenant(db, organizationId, async (tx) => {
              const [existing] = await tx
                .select()
                .from(vatReturns)
                .where(eq(vatReturns.period, body.period))
                .for("update");
              if (existing?.status === "filed")
                throw new ConflictError(`The VAT return of ${body.period} is already filed`);
              const [row] = existing
                ? await tx
                    .update(vatReturns)
                    .set({ ...amounts, calculatedAt: new Date() })
                    .where(eq(vatReturns.id, existing.id))
                    .returning()
                : await tx
                    .insert(vatReturns)
                    .values({ organizationId, period: body.period, createdBy: principal.userId, ...amounts })
                    .returning();
              return { row: row as VatReturn, created: !existing };
            });
            if (saved.created) set.status = 201;
            return view(saved.row);
          },
          {
            body: t.Object({ period: Period }),
            response: { 200: ReturnView, 201: ReturnView },
            detail: { summary: "Calculate (or recalculate) the draft VAT return of a month from the ledger" },
          },
        )
        .get(
          "/vat-returns",
          async ({ principal }) => {
            const rows = await withTenant(db, requireOrganization(principal), (tx) =>
              tx.select().from(vatReturns).orderBy(desc(vatReturns.period)).limit(120),
            );
            return rows.map(view);
          },
          { response: t.Array(ReturnView), detail: { summary: "VAT returns, newest period first" } },
        )
        .get(
          "/vat-returns/:period",
          async ({ principal, params }) => {
            const [row] = await withTenant(db, requireOrganization(principal), (tx) =>
              tx.select().from(vatReturns).where(eq(vatReturns.period, params.period)),
            );
            if (!row) throw new NotFoundError(`No VAT return for ${params.period}`);
            return view(row);
          },
          {
            params: t.Object({ period: Period }),
            response: ReturnView,
            detail: { summary: "The VAT return of a month" },
          },
        )
        .post(
          "/vat-returns/:period/file",
          async ({ principal, params }) => {
            const organizationId = requireOrganization(principal);
            const date = now();
            if (date <= periodEnd(params.period)) {
              throw new UnprocessableError(`The VAT return of ${params.period} can be filed after the month ends`);
            }
            const { accounts, amounts } = await compute(organizationId, params.period);
            const filed = await withTenant(db, organizationId, async (tx) => {
              const [existing] = await tx
                .select()
                .from(vatReturns)
                .where(eq(vatReturns.period, params.period))
                .for("update");
              if (!existing) throw new NotFoundError(`Calculate the VAT return of ${params.period} first`);
              if (existing.status === "filed")
                throw new ConflictError(`The VAT return of ${params.period} is already filed`);
              const [row] = (await tx
                .update(vatReturns)
                .set({
                  ...amounts,
                  status: "filed",
                  filedBy: principal.userId,
                  filedAt: new Date(),
                  calculatedAt: new Date(),
                })
                .where(eq(vatReturns.id, existing.id))
                .returning()) as [VatReturn];
              const journal = settlementJournal(row, accounts, { createdBy: principal.userId, date });
              if (journal) await enqueue(tx, { organizationId, topic: TOPICS.journal, payload: journal });
              return row;
            });
            context.logger.info("vat return filed", {
              "tax.period": filed.period,
              "tax.payable": filed.payable,
              "tax.carried_forward": filed.carriedForward,
            });
            return view(filed);
          },
          {
            params: t.Object({ period: Period }),
            response: ReturnView,
            detail: {
              summary: "File the VAT return: post Dr VAT output, Cr VAT input and Cr tax payable on the filing date",
            },
          },
        ),
  );
}
