import { createHash } from "node:crypto";
import { authentication, type Principal, requireOrganization, type Verifier } from "@deus/auth";
import type { AccountRef, Balances, JournalRequest, Lookup, PaymentRef } from "@deus/clients";
import type { BaseConfig } from "@deus/config";
import { type Database, isUniqueViolation, type Transaction, withTenant } from "@deus/db";
import { ConflictError, NotFoundError, UnprocessableError } from "@deus/errors";
import { createService } from "@deus/http";
import type { Logger } from "@deus/logger";
import { AMOUNT_PATTERN, fromCents, normalize, toCents } from "@deus/money";
import { enqueue } from "@deus/outbox";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { t } from "elysia";
import { type BankAccount, bankAccounts, type StatementLine, type schema, statementLines } from "./schema";

export const TOPICS = { journal: "ledger.journal" } as const;

export interface BankingContext {
  config: BaseConfig;
  logger: Logger;
  db: Database<typeof schema>;
  verify: Verifier;
  accounts: Lookup<AccountRef>;
  payments: Lookup<PaymentRef>;
  balances: Balances;
  readiness?: Array<() => Promise<void>>;
}

type Tx = Transaction<typeof schema>;

const SIGNED_AMOUNT = `^-?${AMOUNT_PATTERN.slice(1)}`;
const Status = t.Union([t.Literal("unmatched"), t.Literal("matched"), t.Literal("posted"), t.Literal("ignored")]);
const AccountView = t.Object({
  id: t.String(),
  name: t.String(),
  bankName: t.String(),
  accountNumber: t.String(),
  ledgerAccountId: t.String(),
  openingBalance: t.String(),
  openingDate: t.String(),
  active: t.Boolean(),
});
const LineView = t.Object({
  id: t.String(),
  date: t.String(),
  description: t.String(),
  amount: t.String(),
  reference: t.Nullable(t.String()),
  status: Status,
  paymentId: t.Nullable(t.String()),
  counterAccountId: t.Nullable(t.String()),
});
const accountView = (account: BankAccount) => ({
  id: account.id,
  name: account.name,
  bankName: account.bankName,
  accountNumber: account.accountNumber,
  ledgerAccountId: account.ledgerAccountId,
  openingBalance: account.openingBalance,
  openingDate: account.openingDate,
  active: account.active,
});
const lineView = (line: StatementLine) => ({
  id: line.id,
  date: line.lineDate,
  description: line.description,
  amount: line.amount,
  reference: line.reference,
  status: line.status,
  paymentId: line.paymentId,
  counterAccountId: line.counterAccountId,
});
const IdParams = t.Object({ id: t.String({ format: "uuid" }) });

export function signedCents(value: string) {
  return value.startsWith("-") ? -toCents(value.slice(1)) : toCents(value);
}

export function fingerprint(
  line: { date: string; amount: string; description: string; reference?: string },
  occurrence: number,
) {
  return createHash("sha256")
    .update(
      [line.date, fromCents(signedCents(line.amount)), line.description.trim(), line.reference ?? "", occurrence].join(
        "|",
      ),
    )
    .digest("hex");
}

export function lineJournal(
  line: StatementLine,
  bank: BankAccount,
  counterAccountId: string,
  description: string,
): JournalRequest {
  const cents = signedCents(line.amount);
  const amount = fromCents(cents < 0n ? -cents : cents);
  const bankSide = { accountId: bank.ledgerAccountId, memo: line.reference ?? line.description };
  const counter = { accountId: counterAccountId, memo: line.description };
  return {
    organizationId: line.organizationId,
    createdBy: line.resolvedBy ?? "",
    date: line.lineDate,
    description,
    sourceId: line.id,
    lines:
      cents > 0n
        ? [
            { ...bankSide, debit: amount },
            { ...counter, credit: amount },
          ]
        : [
            { ...counter, debit: amount },
            { ...bankSide, credit: amount },
          ],
  };
}

async function loadLine(tx: Tx, id: string) {
  const [line] = await tx.select().from(statementLines).where(eq(statementLines.id, id)).for("update");
  if (!line) throw new NotFoundError("The statement line does not exist");
  const [bank] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, line.bankAccountId));
  return { line, bank: bank as BankAccount };
}

export function createApp(context: BankingContext) {
  const { db } = context;

  const tenant = <T>(principal: Principal, work: (tx: Tx, organizationId: string) => Promise<T>) => {
    const organizationId = requireOrganization(principal);
    return withTenant(db, organizationId, (tx) => work(tx, organizationId));
  };

  const postable = async (organizationId: string, accountId: string, allowed: ReadonlySet<AccountRef["type"]>) => {
    const [account] = await context.accounts([accountId], organizationId);
    if (!account?.active || !account.postable || !allowed.has(account.type)) {
      throw new UnprocessableError("The account must be an active account without sub-accounts of the right type", {
        accountId,
      });
    }
    return account;
  };

  const resolve = (tx: Tx, line: StatementLine, values: Partial<StatementLine>) =>
    tx
      .update(statementLines)
      .set({ ...values, resolvedAt: new Date() })
      .where(eq(statementLines.id, line.id))
      .returning();

  return createService({ config: context.config, logger: context.logger, readiness: context.readiness }).group(
    "/api/banking",
    (api) =>
      api
        .use(authentication(context.verify))
        .post(
          "/accounts",
          async ({ principal, body, set }) => {
            const organizationId = requireOrganization(principal);
            await postable(organizationId, body.ledgerAccountId, new Set(["asset"]));
            try {
              const [created] = await withTenant(db, organizationId, (tx) =>
                tx
                  .insert(bankAccounts)
                  .values({
                    organizationId,
                    name: body.name,
                    bankName: body.bankName,
                    accountNumber: body.accountNumber,
                    ledgerAccountId: body.ledgerAccountId,
                    openingBalance: normalize(body.openingBalance ?? "0"),
                    openingDate: body.openingDate,
                  })
                  .returning(),
              );
              set.status = 201;
              return accountView(created as BankAccount);
            } catch (error) {
              if (isUniqueViolation(error))
                throw new ConflictError("The ledger account is already linked to a bank account");
              throw error;
            }
          },
          {
            body: t.Object({
              name: t.String({ minLength: 1, maxLength: 100 }),
              bankName: t.String({ minLength: 1, maxLength: 100 }),
              accountNumber: t.String({ pattern: "^[0-9 -]{4,40}$" }),
              ledgerAccountId: t.String({ format: "uuid" }),
              openingBalance: t.Optional(t.String({ pattern: AMOUNT_PATTERN })),
              openingDate: t.String({ format: "date" }),
            }),
            response: { 201: AccountView },
            detail: { summary: "Link a bank account to an asset account of the chart" },
          },
        )
        .get(
          "/accounts",
          ({ principal }) =>
            tenant(principal, async (tx) =>
              (await tx.select().from(bankAccounts).orderBy(asc(bankAccounts.name))).map(accountView),
            ),
          { response: t.Array(AccountView), detail: { summary: "Bank accounts of the active organization" } },
        )
        .post(
          "/accounts/:id/statements",
          async ({ principal, params, body }) =>
            tenant(principal, async (tx, organizationId) => {
              const [bank] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, params.id));
              if (!bank) throw new NotFoundError("The bank account does not exist");
              const seen = new Map<string, number>();
              const rows = body.lines.map((line) => {
                if (signedCents(line.amount) === 0n) throw new UnprocessableError("A statement line needs an amount");
                if (line.date < bank.openingDate) {
                  throw new UnprocessableError(
                    `Line dated ${line.date} is before the opening date ${bank.openingDate}`,
                  );
                }
                const key = [line.date, line.amount, line.description, line.reference ?? ""].join("|");
                const occurrence = (seen.get(key) ?? 0) + 1;
                seen.set(key, occurrence);
                return {
                  organizationId,
                  bankAccountId: bank.id,
                  lineDate: line.date,
                  description: line.description.trim(),
                  amount: fromCents(signedCents(line.amount)),
                  reference: line.reference ?? null,
                  fingerprint: fingerprint(line, occurrence),
                };
              });
              const inserted = await tx
                .insert(statementLines)
                .values(rows)
                .onConflictDoNothing({
                  target: [statementLines.organizationId, statementLines.bankAccountId, statementLines.fingerprint],
                })
                .returning({ id: statementLines.id });
              return { imported: inserted.length, duplicates: rows.length - inserted.length };
            }),
          {
            params: IdParams,
            body: t.Object({
              lines: t.Array(
                t.Object({
                  date: t.String({ format: "date" }),
                  description: t.String({ minLength: 1, maxLength: 500 }),
                  amount: t.String({ pattern: SIGNED_AMOUNT }),
                  reference: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
                }),
                { minItems: 1, maxItems: 2000 },
              ),
            }),
            response: t.Object({ imported: t.Integer(), duplicates: t.Integer() }),
            detail: { summary: "Import statement lines; a line already imported is skipped" },
          },
        )
        .get(
          "/accounts/:id/lines",
          ({ principal, params, query }) =>
            tenant(principal, async (tx) => {
              const rows = await tx
                .select()
                .from(statementLines)
                .where(
                  and(
                    eq(statementLines.bankAccountId, params.id),
                    query.status ? eq(statementLines.status, query.status) : undefined,
                  ),
                )
                .orderBy(asc(statementLines.lineDate), asc(statementLines.createdAt))
                .limit(1000);
              return rows.map(lineView);
            }),
          {
            params: IdParams,
            query: t.Object({ status: t.Optional(Status) }),
            response: t.Array(LineView),
            detail: { summary: "Statement lines of a bank account, oldest first" },
          },
        )
        .post(
          "/lines/:id/match",
          async ({ principal, params, body }) => {
            const organizationId = requireOrganization(principal);
            const [payment] = await context.payments([body.paymentId], organizationId);
            try {
              return await withTenant(db, organizationId, async (tx) => {
                const { line, bank } = await loadLine(tx, params.id);
                if (line.status !== "unmatched") throw new ConflictError(`The line is already ${line.status}`);
                const cents = signedCents(line.amount);
                if (payment?.status !== "recorded") throw new UnprocessableError("The payment is not recorded");
                if (payment.cashAccountId !== bank.ledgerAccountId) {
                  throw new UnprocessableError("The payment was recorded on another cash account");
                }
                if (
                  cents > 0n !== (payment.kind === "receipt") ||
                  toCents(payment.amount) !== (cents < 0n ? -cents : cents)
                ) {
                  throw new UnprocessableError("The payment does not have the amount and direction of the line");
                }
                const [updated] = await resolve(tx, line, {
                  status: "matched",
                  paymentId: payment.id,
                  resolvedBy: principal.userId,
                });
                return lineView(updated as StatementLine);
              });
            } catch (error) {
              if (isUniqueViolation(error)) throw new ConflictError("The payment is already matched to another line");
              throw error;
            }
          },
          {
            params: IdParams,
            body: t.Object({ paymentId: t.String({ format: "uuid" }) }),
            response: LineView,
            detail: { summary: "Match a line to a recorded payment of the same account, amount and direction" },
          },
        )
        .post(
          "/lines/:id/post",
          async ({ principal, params, body }) => {
            const organizationId = requireOrganization(principal);
            await postable(
              organizationId,
              body.accountId,
              new Set(["expense", "revenue", "liability", "equity", "asset"]),
            );
            return withTenant(db, organizationId, async (tx) => {
              const { line, bank } = await loadLine(tx, params.id);
              if (line.status !== "unmatched") throw new ConflictError(`The line is already ${line.status}`);
              if (body.accountId === bank.ledgerAccountId) throw new UnprocessableError("Post against another account");
              const [updated] = (await resolve(tx, line, {
                status: "posted",
                counterAccountId: body.accountId,
                resolvedBy: principal.userId,
              })) as [StatementLine];
              await enqueue(tx, {
                organizationId,
                topic: TOPICS.journal,
                payload: lineJournal(
                  updated,
                  bank,
                  body.accountId,
                  body.description ?? `${bank.name}: ${line.description}`,
                ),
              });
              return lineView(updated);
            });
          },
          {
            params: IdParams,
            body: t.Object({
              accountId: t.String({ format: "uuid" }),
              description: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
            }),
            response: LineView,
            detail: { summary: "Post a line without a payment (bank fees, interest) against another account" },
          },
        )
        .post(
          "/lines/:id/ignore",
          ({ principal, params }) =>
            tenant(principal, async (tx) => {
              const { line } = await loadLine(tx, params.id);
              if (line.status !== "unmatched") throw new ConflictError(`The line is already ${line.status}`);
              const [updated] = await resolve(tx, line, { status: "ignored", resolvedBy: principal.userId });
              return lineView(updated as StatementLine);
            }),
          { params: IdParams, response: LineView, detail: { summary: "Ignore a line that needs no entry" } },
        )
        .post(
          "/lines/:id/unmatch",
          ({ principal, params }) =>
            tenant(principal, async (tx) => {
              const { line } = await loadLine(tx, params.id);
              if (line.status !== "matched" && line.status !== "ignored") {
                throw new ConflictError("Only matched or ignored lines can be reopened");
              }
              const [updated] = await resolve(tx, line, {
                status: "unmatched",
                paymentId: null,
                resolvedBy: principal.userId,
              });
              return lineView(updated as StatementLine);
            }),
          { params: IdParams, response: LineView, detail: { summary: "Reopen a matched or ignored line" } },
        )
        .get(
          "/accounts/:id/reconciliation",
          async ({ principal, params, query }) => {
            const organizationId = requireOrganization(principal);
            const { bank, statementCents, open } = await withTenant(db, organizationId, async (tx) => {
              const [account] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, params.id));
              if (!account) throw new NotFoundError("The bank account does not exist");
              const [total] = await tx
                .select({ sum: sql<string>`coalesce(sum(${statementLines.amount}), 0)::numeric(20, 2)::text` })
                .from(statementLines)
                .where(and(eq(statementLines.bankAccountId, account.id), lte(statementLines.lineDate, query.asOf)));
              const unmatched = await tx
                .select()
                .from(statementLines)
                .where(
                  and(
                    eq(statementLines.bankAccountId, account.id),
                    eq(statementLines.status, "unmatched"),
                    lte(statementLines.lineDate, query.asOf),
                  ),
                )
                .orderBy(asc(statementLines.lineDate));
              return {
                bank: account,
                statementCents: toCents(account.openingBalance) + signedCents(total?.sum ?? "0"),
                open: unmatched,
              };
            });
            const [ledger] = await context.balances(organizationId, {
              to: query.asOf,
              accountId: [bank.ledgerAccountId],
            });
            const ledgerCents = ledger ? toCents(ledger.debit) - toCents(ledger.credit) : 0n;
            return {
              asOf: query.asOf,
              statementBalance: fromCents(statementCents),
              ledgerBalance: fromCents(ledgerCents),
              difference: fromCents(statementCents - ledgerCents),
              reconciled: statementCents === ledgerCents && open.length === 0,
              unmatched: open.map(lineView),
            };
          },
          {
            params: IdParams,
            query: t.Object({ asOf: t.String({ format: "date" }) }),
            detail: { summary: "Statement balance against the ledger balance of the linked account, with open lines" },
          },
        ),
  );
}
