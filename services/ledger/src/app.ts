import { createHash } from "node:crypto";
import {
  authentication,
  requireOrganization,
  type ServiceVerifier,
  serviceAuthentication,
  type Verifier,
} from "@deus/auth";
import type { AccountRef, Lookup } from "@deus/clients";
import type { BaseConfig } from "@deus/config";
import { type Database, isUniqueViolation, type Transaction, withTenant } from "@deus/db";
import { BadRequestError, ConflictError, NotFoundError, UnprocessableError } from "@deus/errors";
import { createService } from "@deus/http";
import type { Logger } from "@deus/logger";
import { AMOUNT_PATTERN, fromCents, toCents } from "@deus/money";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { t } from "elysia";
import { type LineInput, type NormalizedLine, normalizeLines, periodOf } from "./rules";
import { closedPeriods, type Journal, type JournalLine, journalLines, journals, type schema } from "./schema";

export type AccountsLookup = Lookup<AccountRef>;

export const JOURNAL_SOURCES = ["sales", "purchases", "payments", "banking", "tax"] as const;

export interface LedgerContext {
  config: BaseConfig;
  logger: Logger;
  db: Database<typeof schema>;
  verify: Verifier;
  verifyService: ServiceVerifier;
  accounts: AccountsLookup;
  readiness?: Array<() => Promise<void>>;
}

type Tx = Transaction<typeof schema>;

const DEBIT_NORMAL = new Set(["asset", "expense"]);
const Amount = t.String({ pattern: AMOUNT_PATTERN });
const Period = t.String({ pattern: "^[0-9]{4}-(0[1-9]|1[0-2])$" });
const LineBody = t.Object({
  accountId: t.String({ format: "uuid" }),
  debit: t.Optional(Amount),
  credit: t.Optional(Amount),
  memo: t.Optional(t.String({ maxLength: 500 })),
});
const LineView = t.Object({
  lineNo: t.Integer(),
  accountId: t.String(),
  debit: t.String(),
  credit: t.String(),
  memo: t.Nullable(t.String()),
});
const JournalView = t.Object({
  id: t.String(),
  date: t.String(),
  description: t.String(),
  status: t.UnionEnum(["draft", "posted"]),
  source: t.String(),
  sourceId: t.Nullable(t.String()),
  reversalOf: t.Nullable(t.String()),
  postedAt: t.Nullable(t.String()),
  total: t.String(),
  lines: t.Array(LineView),
});

function view(journal: Journal, lines: JournalLine[]) {
  const ordered = [...lines].sort((a, b) => a.lineNo - b.lineNo);
  return {
    id: journal.id,
    date: journal.entryDate,
    description: journal.description,
    status: journal.status,
    source: journal.source,
    sourceId: journal.sourceId,
    reversalOf: journal.reversalOf,
    postedAt: journal.postedAt ? journal.postedAt.toISOString() : null,
    total: fromCents(ordered.reduce((sum, line) => sum + toCents(line.debit), 0n)),
    lines: ordered.map((line) => ({
      lineNo: line.lineNo,
      accountId: line.accountId,
      debit: line.debit,
      credit: line.credit,
      memo: line.memo,
    })),
  };
}

async function load(tx: Tx, id: string) {
  const [journal] = await tx.select().from(journals).where(eq(journals.id, id));
  if (!journal) throw new NotFoundError("The journal does not exist");
  const lines = await tx.select().from(journalLines).where(eq(journalLines.journalId, id));
  return { journal, lines };
}

async function lockPeriod(tx: Tx, organizationId: string, period: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${organizationId}:${period}`}, 0))`);
}

async function assertOpen(tx: Tx, organizationId: string, isoDate: string) {
  const period = periodOf(isoDate);
  await lockPeriod(tx, organizationId, period);
  const [closed] = await tx.select().from(closedPeriods).where(eq(closedPeriods.period, period));
  if (closed) throw new UnprocessableError(`The period ${period} is closed`, { period });
}

function requestHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createApp(context: LedgerContext) {
  const { db } = context;

  const assertAccounts = async (lines: readonly { accountId: string }[], organizationId: string) => {
    const ids = [...new Set(lines.map((line) => line.accountId))];
    const found = new Map((await context.accounts(ids, organizationId)).map((account) => [account.id, account]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw new UnprocessableError("Some accounts do not exist", { missing });
    const inactive = ids.filter((id) => !found.get(id)?.active);
    if (inactive.length > 0) throw new UnprocessableError("Some accounts are inactive", { inactive });
    const headers = ids.filter((id) => found.get(id)?.postable === false);
    if (headers.length > 0) {
      throw new UnprocessableError("Some accounts are header accounts; post to their sub-accounts", { headers });
    }
  };

  const insertJournal = async (
    tx: Tx,
    organizationId: string,
    actorId: string,
    input: {
      date: string;
      description: string;
      lines: NormalizedLine[];
      post: boolean;
      source?: string;
      sourceId?: string | null;
      idempotencyKey?: string | null;
      requestHash?: string | null;
      reversalOf?: string | null;
    },
  ) => {
    if (input.post) await assertOpen(tx, organizationId, input.date);
    const [journal] = await tx
      .insert(journals)
      .values({
        organizationId,
        entryDate: input.date,
        description: input.description,
        source: input.source ?? "manual",
        sourceId: input.sourceId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        requestHash: input.requestHash ?? null,
        reversalOf: input.reversalOf ?? null,
        createdBy: actorId,
      })
      .returning();
    const id = (journal as Journal).id;
    await tx.insert(journalLines).values(input.lines.map((line) => ({ ...line, journalId: id, organizationId })));
    if (input.post) {
      await tx.update(journals).set({ status: "posted", postedAt: new Date() }).where(eq(journals.id, id));
    }
    return load(tx, id);
  };

  const reverse = (
    tx: Tx,
    organizationId: string,
    actorId: string,
    original: Awaited<ReturnType<typeof load>>,
    input: { date?: string; description?: string },
  ) => {
    if (original.journal.status !== "posted") throw new UnprocessableError("Only posted journals can be reversed");
    if (original.journal.reversalOf) throw new UnprocessableError("A reversal cannot be reversed");
    const lines = [...original.lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((line) => ({
        lineNo: line.lineNo,
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
        memo: line.memo,
      }));
    return insertJournal(tx, organizationId, actorId, {
      date: input.date ?? original.journal.entryDate,
      description: input.description ?? `Reversal of ${original.journal.description}`,
      lines,
      post: true,
      source: "reversal",
      sourceId: original.journal.id,
      reversalOf: original.journal.id,
    });
  };

  const record = async (input: {
    organizationId: string;
    actorId: string;
    key: string | null;
    source: string;
    sourceId: string | null;
    date: string;
    description: string;
    lines: LineInput[];
    post: boolean;
  }) => {
    const { organizationId, key } = input;
    if (key !== null && (key.length === 0 || key.length > 200)) {
      throw new BadRequestError("Idempotency-Key must be 1 to 200 characters");
    }
    const { lines } = normalizeLines(input.lines);
    const hash = key
      ? requestHash({
          date: input.date,
          description: input.description,
          lines,
          post: input.post,
          source: input.source,
          sourceId: input.sourceId,
        })
      : null;
    const replay = async () => {
      if (!key) return undefined;
      return withTenant(db, organizationId, async (tx) => {
        const [existing] = await tx.select().from(journals).where(eq(journals.idempotencyKey, key));
        if (!existing) return undefined;
        if (existing.requestHash !== hash) {
          throw new UnprocessableError("The Idempotency-Key was already used for a different journal");
        }
        const loaded = await load(tx, existing.id);
        return view(loaded.journal, loaded.lines);
      });
    };
    const previous = await replay();
    if (previous) return { journal: previous, replayed: true };
    await assertAccounts(lines, organizationId);
    try {
      const created = await withTenant(db, organizationId, (tx) =>
        insertJournal(tx, organizationId, input.actorId, {
          date: input.date,
          description: input.description,
          lines,
          post: input.post,
          source: input.source,
          sourceId: input.sourceId,
          idempotencyKey: key,
          requestHash: hash,
        }),
      );
      return { journal: view(created.journal, created.lines), replayed: false };
    } catch (error) {
      if (key && isUniqueViolation(error)) {
        const raced = await replay();
        if (raced) return { journal: raced, replayed: true };
      }
      throw error;
    }
  };

  const respond = (
    result: { journal: ReturnType<typeof view>; replayed: boolean },
    set: { status?: number | string; headers: Record<string, unknown> },
  ) => {
    if (result.replayed) set.headers["idempotent-replayed"] = "true";
    else set.status = 201;
    return result.journal;
  };

  return createService({ config: context.config, logger: context.logger, readiness: context.readiness })
    .group("/api/ledger", (api) =>
      api
        .use(authentication(context.verify))
        .post(
          "/journals",
          async ({ principal, body, headers, set }) =>
            respond(
              await record({
                organizationId: requireOrganization(principal),
                actorId: principal.userId,
                key: headers["idempotency-key"] ?? null,
                source: "manual",
                sourceId: body.sourceId ?? null,
                date: body.date,
                description: body.description,
                lines: body.lines as LineInput[],
                post: body.post ?? true,
              }),
              set,
            ),
          {
            body: t.Object({
              date: t.String({ format: "date" }),
              description: t.String({ minLength: 1, maxLength: 500 }),
              lines: t.Array(LineBody, { minItems: 2, maxItems: 500 }),
              post: t.Optional(t.Boolean()),
              sourceId: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
            }),
            response: { 200: JournalView, 201: JournalView },
            detail: {
              summary: "Record a journal; posted unless post is false. Idempotent with the Idempotency-Key header",
            },
          },
        )
        .get(
          "/journals",
          async ({ principal, query }) => {
            const conditions = [
              query.from ? gte(journals.entryDate, query.from) : undefined,
              query.to ? lte(journals.entryDate, query.to) : undefined,
              query.status ? eq(journals.status, query.status) : undefined,
            ].filter((condition) => condition !== undefined);
            return withTenant(db, requireOrganization(principal), async (tx) => {
              const rows = await tx
                .select()
                .from(journals)
                .where(and(...conditions))
                .orderBy(desc(journals.entryDate), desc(journals.createdAt))
                .limit(200);
              if (rows.length === 0) return [];
              const lines = await tx
                .select()
                .from(journalLines)
                .where(
                  inArray(
                    journalLines.journalId,
                    rows.map((row) => row.id),
                  ),
                );
              return rows.map((row) =>
                view(
                  row,
                  lines.filter((line) => line.journalId === row.id),
                ),
              );
            });
          },
          {
            query: t.Object({
              from: t.Optional(t.String({ format: "date" })),
              to: t.Optional(t.String({ format: "date" })),
              status: t.Optional(t.Union([t.Literal("draft"), t.Literal("posted")])),
            }),
            response: t.Array(JournalView),
            detail: { summary: "Journals of the active organization, newest first (at most 200)" },
          },
        )
        .get(
          "/journals/:id",
          async ({ principal, params }) => {
            const loaded = await withTenant(db, requireOrganization(principal), (tx) => load(tx, params.id));
            return view(loaded.journal, loaded.lines);
          },
          {
            params: t.Object({ id: t.String({ format: "uuid" }) }),
            response: JournalView,
            detail: { summary: "One journal" },
          },
        )
        .post(
          "/journals/:id/post",
          async ({ principal, params }) => {
            const organizationId = requireOrganization(principal);
            const draft = await withTenant(db, organizationId, (tx) => load(tx, params.id));
            if (draft.journal.status === "posted") throw new ConflictError("The journal is already posted");
            await assertAccounts(draft.lines, organizationId);
            const posted = await withTenant(db, organizationId, async (tx) => {
              await assertOpen(tx, organizationId, draft.journal.entryDate);
              const [updated] = await tx
                .update(journals)
                .set({ status: "posted", postedAt: new Date() })
                .where(and(eq(journals.id, params.id), eq(journals.status, "draft")))
                .returning();
              if (!updated) throw new ConflictError("The journal is already posted");
              return load(tx, params.id);
            });
            return view(posted.journal, posted.lines);
          },
          {
            params: t.Object({ id: t.String({ format: "uuid" }) }),
            response: JournalView,
            detail: { summary: "Post a draft journal" },
          },
        )
        .post(
          "/journals/:id/reverse",
          async ({ principal, params, body, set }) => {
            const organizationId = requireOrganization(principal);
            try {
              const reversal = await withTenant(db, organizationId, async (tx) =>
                reverse(tx, organizationId, principal.userId, await load(tx, params.id), body ?? {}),
              );
              set.status = 201;
              return view(reversal.journal, reversal.lines);
            } catch (error) {
              if (isUniqueViolation(error)) throw new ConflictError("The journal is already reversed");
              throw error;
            }
          },
          {
            params: t.Object({ id: t.String({ format: "uuid" }) }),
            body: t.Optional(
              t.Object({
                date: t.Optional(t.String({ format: "date" })),
                description: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
              }),
            ),
            response: { 201: JournalView },
            detail: { summary: "Reverse a posted journal with a posted journal of opposite sides" },
          },
        )
        .get(
          "/trial-balance",
          async ({ principal, query }) => {
            const organizationId = requireOrganization(principal);
            const totals = await withTenant(db, organizationId, (tx) =>
              tx
                .select({
                  accountId: journalLines.accountId,
                  debit: sql<string>`sum(${journalLines.debit})`,
                  credit: sql<string>`sum(${journalLines.credit})`,
                })
                .from(journalLines)
                .innerJoin(journals, eq(journals.id, journalLines.journalId))
                .where(and(eq(journals.status, "posted"), lte(journals.entryDate, query.asOf)))
                .groupBy(journalLines.accountId),
            );
            const accounts =
              totals.length === 0
                ? new Map<string, AccountRef>()
                : new Map(
                    (
                      await context.accounts(
                        totals.map((row) => row.accountId),
                        organizationId,
                      )
                    ).map((account) => [account.id, account]),
                  );
            let debit = 0n;
            let credit = 0n;
            const rows = totals
              .map((row) => {
                const account = accounts.get(row.accountId);
                const rowDebit = toCents(row.debit);
                const rowCredit = toCents(row.credit);
                debit += rowDebit;
                credit += rowCredit;
                const normalDebit = DEBIT_NORMAL.has(account?.type ?? "asset");
                return {
                  accountId: row.accountId,
                  code: account?.code ?? null,
                  name: account?.name ?? null,
                  type: account?.type ?? null,
                  debit: fromCents(rowDebit),
                  credit: fromCents(rowCredit),
                  balance: fromCents(normalDebit ? rowDebit - rowCredit : rowCredit - rowDebit),
                };
              })
              .sort((a, b) => (a.code ?? "").localeCompare(b.code ?? ""));
            return {
              asOf: query.asOf,
              rows,
              debit: fromCents(debit),
              credit: fromCents(credit),
              balanced: debit === credit,
            };
          },
          {
            query: t.Object({ asOf: t.String({ format: "date" }) }),
            response: t.Object({
              asOf: t.String(),
              rows: t.Array(
                t.Object({
                  accountId: t.String(),
                  code: t.Nullable(t.String()),
                  name: t.Nullable(t.String()),
                  type: t.Nullable(t.String()),
                  debit: t.String(),
                  credit: t.String(),
                  balance: t.String(),
                }),
              ),
              debit: t.String(),
              credit: t.String(),
              balanced: t.Boolean(),
            }),
            detail: { summary: "Debit, credit and balance per account over posted journals up to a date" },
          },
        )
        .get(
          "/periods",
          async ({ principal }) => {
            const rows = await withTenant(db, requireOrganization(principal), (tx) =>
              tx
                .select({ period: closedPeriods.period, closedAt: closedPeriods.closedAt })
                .from(closedPeriods)
                .orderBy(asc(closedPeriods.period)),
            );
            return rows.map((row) => ({ period: row.period, closedAt: row.closedAt.toISOString() }));
          },
          {
            response: t.Array(t.Object({ period: t.String(), closedAt: t.String() })),
            detail: { summary: "Closed periods" },
          },
        )
        .post(
          "/periods/:period/close",
          async ({ principal, params, set }) => {
            const organizationId = requireOrganization(principal);
            try {
              const [closed] = await withTenant(db, organizationId, async (tx) => {
                await lockPeriod(tx, organizationId, params.period);
                return tx
                  .insert(closedPeriods)
                  .values({ organizationId, period: params.period, closedBy: principal.userId })
                  .returning();
              });
              set.status = 201;
              return { period: params.period, closedAt: (closed as { closedAt: Date }).closedAt.toISOString() };
            } catch (error) {
              if (isUniqueViolation(error)) throw new ConflictError(`The period ${params.period} is already closed`);
              throw error;
            }
          },
          {
            params: t.Object({ period: Period }),
            response: { 201: t.Object({ period: t.String(), closedAt: t.String() }) },
            detail: { summary: "Close a period: journals dated in it can no longer be posted" },
          },
        ),
    )
    .group("/internal/ledger", (internal) =>
      internal
        .use(serviceAuthentication(context.verifyService, JOURNAL_SOURCES))
        .post(
          "/journals",
          async ({ caller, body, headers, set }) => {
            const key = headers["idempotency-key"];
            if (!key) throw new BadRequestError("Idempotency-Key is required");
            return respond(
              await record({
                organizationId: body.organizationId,
                actorId: body.createdBy,
                key,
                source: caller.service,
                sourceId: body.sourceId,
                date: body.date,
                description: body.description,
                lines: body.lines as LineInput[],
                post: true,
              }),
              set,
            );
          },
          {
            body: t.Object({
              organizationId: t.String({ format: "uuid" }),
              createdBy: t.String({ format: "uuid" }),
              date: t.String({ format: "date" }),
              description: t.String({ minLength: 1, maxLength: 500 }),
              lines: t.Array(LineBody, { minItems: 2, maxItems: 500 }),
              sourceId: t.String({ minLength: 1, maxLength: 200 }),
            }),
            response: { 200: JournalView, 201: JournalView },
            detail: { summary: "Post a journal on behalf of another service (source = the calling service)" },
          },
        )
        .post(
          "/journals/reverse",
          async ({ caller, body, set }) => {
            const { organizationId } = body;
            const findReversal = (tx: Tx, originalId: string) =>
              tx.select().from(journals).where(eq(journals.reversalOf, originalId));
            const result = await withTenant(db, organizationId, async (tx) => {
              const [original] = await tx
                .select()
                .from(journals)
                .where(
                  and(
                    eq(journals.source, caller.service),
                    eq(journals.sourceId, body.sourceId),
                    isNull(journals.reversalOf),
                  ),
                );
              if (!original) throw new NotFoundError(`No ${caller.service} journal for ${body.sourceId}`);
              const [existing] = await findReversal(tx, original.id);
              if (existing) return { ...(await load(tx, existing.id)), created: false };
              return {
                ...(await reverse(tx, organizationId, body.createdBy, await load(tx, original.id), body)),
                created: true,
              };
            }).catch(async (error: unknown) => {
              if (!isUniqueViolation(error)) throw error;
              return withTenant(db, organizationId, async (tx) => {
                const [original] = await tx
                  .select()
                  .from(journals)
                  .where(and(eq(journals.source, caller.service), eq(journals.sourceId, body.sourceId)));
                const [existing] = await findReversal(tx, original?.id ?? "");
                if (!existing) throw error;
                return { ...(await load(tx, existing.id)), created: false };
              });
            });
            if (result.created) set.status = 201;
            else set.headers["idempotent-replayed"] = "true";
            return view(result.journal, result.lines);
          },
          {
            body: t.Object({
              organizationId: t.String({ format: "uuid" }),
              createdBy: t.String({ format: "uuid" }),
              sourceId: t.String({ minLength: 1, maxLength: 200 }),
              date: t.Optional(t.String({ format: "date" })),
              description: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
            }),
            response: { 200: JournalView, 201: JournalView },
            detail: { summary: "Reverse the journal another service posted for a source document, once" },
          },
        ),
    );
}
