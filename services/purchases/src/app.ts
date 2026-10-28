import {
  authentication,
  type Principal,
  requireOrganization,
  type ServiceVerifier,
  serviceAuthentication,
  type Verifier,
} from "@deus/auth";
import type { AccountRef, AccountsByCode, ContactRef, Lookup, ProductRef } from "@deus/clients";
import type { BaseConfig } from "@deus/config";
import { type Database, isUniqueViolation, type Transaction, withTenant } from "@deus/db";
import {
  addDays,
  documentNumber,
  lineAccountIds,
  PURCHASE_PRICING,
  priceLines,
  today,
  trimQuantity,
} from "@deus/documents";
import { ConflictError, NotFoundError, UnprocessableError } from "@deus/errors";
import { createService } from "@deus/http";
import type { Logger } from "@deus/logger";
import { AMOUNT_PATTERN, fromCents, QUANTITY_PATTERN, RATE_PATTERN, toCents } from "@deus/money";
import { enqueue } from "@deus/outbox";
import { and, desc, eq, gte, inArray, isNull, lte, type SQL, sql } from "drizzle-orm";
import { t } from "elysia";
import { billJournal, type PurchaseAccounts } from "./journal";
import { type Bill, type BillLine, billLines, billPayments, billSequences, bills, type schema } from "./schema";

export const TOPICS = { journal: "ledger.journal", reversal: "ledger.reversal" } as const;
export const LOOKUP_CALLERS = ["payments", "reporting", "notification"] as const;
export const ALLOCATION_CALLERS = ["payments"] as const;

export interface PurchasesContext {
  config: BaseConfig;
  logger: Logger;
  db: Database<typeof schema>;
  verify: Verifier;
  verifyService: ServiceVerifier;
  accounts: Lookup<AccountRef>;
  accountsByCode: AccountsByCode;
  contacts: Lookup<ContactRef>;
  products: Lookup<ProductRef>;
  payableAccountCode: string;
  vatInputAccountCode: string;
  readiness?: Array<() => Promise<void>>;
}

type Tx = Transaction<typeof schema>;

const Status = t.Union([t.Literal("draft"), t.Literal("approved"), t.Literal("void")]);
const LineBody = t.Object({
  productId: t.Optional(t.String({ format: "uuid" })),
  description: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
  quantity: t.String({ pattern: QUANTITY_PATTERN }),
  unitPrice: t.Optional(t.String({ pattern: AMOUNT_PATTERN })),
  vatRate: t.Optional(t.String({ pattern: RATE_PATTERN })),
  accountId: t.Optional(t.String({ format: "uuid" })),
});
const DraftBody = t.Object({
  contactId: t.String({ format: "uuid" }),
  billDate: t.String({ format: "date" }),
  dueDate: t.Optional(t.String({ format: "date" })),
  vendorReference: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  notes: t.Optional(t.String({ maxLength: 2000 })),
  lines: t.Array(LineBody, { minItems: 1, maxItems: 200 }),
});
const LineView = t.Object({
  lineNo: t.Integer(),
  productId: t.Nullable(t.String()),
  description: t.String(),
  quantity: t.String(),
  unitPrice: t.String(),
  vatRate: t.String(),
  amount: t.String(),
  vatAmount: t.String(),
  accountId: t.String(),
});
const BillView = t.Object({
  id: t.String(),
  number: t.Nullable(t.String()),
  vendorReference: t.Nullable(t.String()),
  status: Status,
  contactId: t.String(),
  contactName: t.String(),
  billDate: t.String(),
  dueDate: t.String(),
  notes: t.Nullable(t.String()),
  subtotal: t.String(),
  vatTotal: t.String(),
  total: t.String(),
  amountPaid: t.String(),
  amountDue: t.String(),
  paymentStatus: t.Union([t.Literal("unpaid"), t.Literal("partial"), t.Literal("paid")]),
  lines: t.Array(LineView),
});
const IdParams = t.Object({ id: t.String({ format: "uuid" }) });

function paymentStatus(total: string, paid: string) {
  const paidCents = toCents(paid);
  if (paidCents === 0n) return "unpaid" as const;
  return paidCents >= toCents(total) ? ("paid" as const) : ("partial" as const);
}

const DocumentView = t.Object({
  id: t.String(),
  number: t.Nullable(t.String()),
  status: t.String(),
  contactId: t.String(),
  contactName: t.String(),
  date: t.String(),
  dueDate: t.String(),
  total: t.String(),
  amountPaid: t.String(),
  amountDue: t.String(),
});
const documentView = (bill: Bill) => ({
  id: bill.id,
  number: bill.number,
  status: bill.status,
  contactId: bill.contactId,
  contactName: bill.contactName,
  date: bill.billDate,
  dueDate: bill.dueDate,
  total: bill.total,
  amountPaid: bill.amountPaid,
  amountDue: fromCents(toCents(bill.total) - toCents(bill.amountPaid)),
});
const Ids = t.Union([
  t.String({ format: "uuid" }),
  t.Array(t.String({ format: "uuid" }), { minItems: 1, maxItems: 200 }),
]);

function view(bill: Bill, lines: BillLine[]) {
  const due = toCents(bill.total) - toCents(bill.amountPaid);
  return {
    id: bill.id,
    number: bill.number,
    vendorReference: bill.vendorReference,
    status: bill.status,
    contactId: bill.contactId,
    contactName: bill.contactName,
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    notes: bill.notes,
    subtotal: bill.subtotal,
    vatTotal: bill.vatTotal,
    total: bill.total,
    amountPaid: bill.amountPaid,
    amountDue: bill.status === "void" ? "0.00" : fromCents(due),
    paymentStatus: paymentStatus(bill.total, bill.amountPaid),
    lines: [...lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((line) => ({
        lineNo: line.lineNo,
        productId: line.productId,
        description: line.description,
        quantity: trimQuantity(line.quantity),
        unitPrice: line.unitPrice,
        vatRate: line.vatRate,
        amount: line.amount,
        vatAmount: line.vatAmount,
        accountId: line.accountId,
      })),
  };
}

async function load(tx: Tx, id: string, lock = false) {
  const query = tx.select().from(bills).where(eq(bills.id, id));
  const [bill] = await (lock ? query.for("update") : query);
  if (!bill) throw new NotFoundError("The bill does not exist");
  const lines = await tx.select().from(billLines).where(eq(billLines.billId, id));
  return { bill, lines };
}

async function nextNumber(tx: Tx, organizationId: string, year: number) {
  const [row] = await tx
    .insert(billSequences)
    .values({ organizationId, year, last: 1 })
    .onConflictDoUpdate({
      target: [billSequences.organizationId, billSequences.year],
      set: { last: sql`${billSequences.last} + 1` },
    })
    .returning({ last: billSequences.last });
  return documentNumber("BILL", year, row?.last ?? 1);
}

export function createApp(context: PurchasesContext) {
  const { db } = context;

  const resolveDraft = async (organizationId: string, body: typeof DraftBody.static) => {
    const [contact] = await context.contacts([body.contactId], organizationId);
    if (!contact?.active || !contact.isVendor) {
      throw new UnprocessableError("The contact must be an active vendor", { contactId: body.contactId });
    }
    const productIds = body.lines.flatMap((line) => (line.productId ? [line.productId] : []));
    const products = new Map(
      (productIds.length ? await context.products(productIds, organizationId) : []).map((product) => [
        product.id,
        product,
      ]),
    );
    const lines = body.lines;
    const accountIds = lineAccountIds(lines, products, PURCHASE_PRICING);
    const accounts = new Map(
      (accountIds.length ? await context.accounts(accountIds, organizationId) : []).map((account) => [
        account.id,
        account,
      ]),
    );
    const priced = priceLines(lines, products, accounts, PURCHASE_PRICING);
    const dueDate = body.dueDate ?? addDays(body.billDate, contact.paymentTermsDays);
    if (dueDate < body.billDate) throw new UnprocessableError("The due date is before the bill date");
    return { contact, priced, dueDate };
  };

  const purchaseAccounts = async (organizationId: string): Promise<PurchaseAccounts> => {
    const codes = [context.payableAccountCode, context.vatInputAccountCode];
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
      payable: pick(context.payableAccountCode, "liability"),
      vatInput: pick(context.vatInputAccountCode, "asset"),
    };
  };

  const writeLines = (tx: Tx, organizationId: string, billId: string, lines: ReturnType<typeof priceLines>["lines"]) =>
    tx.insert(billLines).values(lines.map((line) => ({ ...line, billId, organizationId })));

  const duplicate = (reference: string | undefined) => (error: unknown) => {
    if (isUniqueViolation(error)) {
      throw new ConflictError(`The vendor's invoice ${reference} is already recorded`, undefined, { cause: error });
    }
    throw error;
  };

  const tenant = <T>(principal: Principal, work: (tx: Tx, organizationId: string) => Promise<T>) => {
    const organizationId = requireOrganization(principal);
    return withTenant(db, organizationId, (tx) => work(tx, organizationId));
  };

  return createService({ config: context.config, logger: context.logger, readiness: context.readiness })
    .group("/api/purchases", (api) =>
      api
        .use(authentication(context.verify))
        .post(
          "/bills",
          async ({ principal, body, set }) => {
            const organizationId = requireOrganization(principal);
            const { contact, priced, dueDate } = await resolveDraft(organizationId, body);
            const created = await withTenant(db, organizationId, async (tx) => {
              const [bill] = await tx
                .insert(bills)
                .values({
                  organizationId,
                  contactId: contact.id,
                  contactName: contact.name,
                  billDate: body.billDate,
                  vendorReference: body.vendorReference ?? null,
                  dueDate,
                  notes: body.notes ?? null,
                  subtotal: priced.subtotal,
                  vatTotal: priced.vatTotal,
                  total: priced.total,
                  createdBy: principal.userId,
                })
                .returning();
              const id = (bill as Bill).id;
              await writeLines(tx, organizationId, id, priced.lines);
              return load(tx, id);
            }).catch(duplicate(body.vendorReference));
            set.status = 201;
            return view(created.bill, created.lines);
          },
          {
            body: DraftBody,
            response: { 201: BillView },
            detail: {
              summary: "Create a draft bill; lines default to the product's name, purchase price, VAT and account",
            },
          },
        )
        .get(
          "/bills",
          async ({ principal, query }) =>
            tenant(principal, async (tx) => {
              const conditions: SQL[] = [];
              if (query.status) conditions.push(eq(bills.status, query.status));
              if (query.contactId) conditions.push(eq(bills.contactId, query.contactId));
              if (query.from) conditions.push(gte(bills.billDate, query.from));
              if (query.to) conditions.push(lte(bills.billDate, query.to));
              const rows = await tx
                .select()
                .from(bills)
                .where(and(...conditions))
                .orderBy(desc(bills.billDate), desc(bills.createdAt))
                .limit(200);
              const lines = rows.length
                ? await tx
                    .select()
                    .from(billLines)
                    .where(sql`${billLines.billId} in ${rows.map((row) => row.id)}`)
                : [];
              return rows.map((row) =>
                view(
                  row,
                  lines.filter((line) => line.billId === row.id),
                ),
              );
            }),
          {
            query: t.Object({
              status: t.Optional(Status),
              contactId: t.Optional(t.String({ format: "uuid" })),
              from: t.Optional(t.String({ format: "date" })),
              to: t.Optional(t.String({ format: "date" })),
            }),
            response: t.Array(BillView),
            detail: { summary: "Bills of the active organization, newest first (at most 200)" },
          },
        )
        .get(
          "/bills/:id",
          async ({ principal, params }) => {
            const loaded = await tenant(principal, (tx) => load(tx, params.id));
            return view(loaded.bill, loaded.lines);
          },
          { params: IdParams, response: BillView, detail: { summary: "One bill" } },
        )
        .put(
          "/bills/:id",
          async ({ principal, params, body }) => {
            const organizationId = requireOrganization(principal);
            const { contact, priced, dueDate } = await resolveDraft(organizationId, body);
            const updated = await withTenant(db, organizationId, async (tx) => {
              const { bill } = await load(tx, params.id, true);
              if (bill.status !== "draft") throw new ConflictError("Only draft bills can be changed");
              await tx
                .update(bills)
                .set({
                  contactId: contact.id,
                  contactName: contact.name,
                  billDate: body.billDate,
                  vendorReference: body.vendorReference ?? null,
                  dueDate,
                  notes: body.notes ?? null,
                  subtotal: priced.subtotal,
                  vatTotal: priced.vatTotal,
                  total: priced.total,
                  updatedAt: new Date(),
                })
                .where(eq(bills.id, bill.id));
              await tx.delete(billLines).where(eq(billLines.billId, bill.id));
              await writeLines(tx, organizationId, bill.id, priced.lines);
              return load(tx, bill.id);
            }).catch(duplicate(body.vendorReference));
            return view(updated.bill, updated.lines);
          },
          { params: IdParams, body: DraftBody, response: BillView, detail: { summary: "Replace a draft bill" } },
        )
        .delete(
          "/bills/:id",
          async ({ principal, params, set }) => {
            await tenant(principal, async (tx) => {
              const { bill } = await load(tx, params.id, true);
              if (bill.status !== "draft") throw new ConflictError("Only draft bills can be deleted; void it instead");
              await tx.delete(bills).where(eq(bills.id, bill.id));
            });
            set.status = 204;
          },
          { params: IdParams, detail: { summary: "Delete a draft bill" } },
        )
        .post(
          "/bills/:id/approve",
          async ({ principal, params }) => {
            const organizationId = requireOrganization(principal);
            const accounts = await purchaseAccounts(organizationId);
            const approved = await withTenant(db, organizationId, async (tx) => {
              const { bill, lines } = await load(tx, params.id, true);
              if (bill.status !== "draft") throw new ConflictError(`The bill is already ${bill.status}`);
              if (toCents(bill.total) === 0n)
                throw new UnprocessableError("A bill without an amount cannot be approved");
              const number = await nextNumber(tx, organizationId, Number(bill.billDate.slice(0, 4)));
              const [updated] = await tx
                .update(bills)
                .set({ status: "approved", number, approvedAt: new Date(), updatedAt: new Date() })
                .where(eq(bills.id, bill.id))
                .returning();
              await enqueue(tx, {
                organizationId,
                topic: TOPICS.journal,
                payload: billJournal(updated as Bill, lines, accounts),
              });
              return { bill: updated as Bill, lines };
            });
            context.logger.info("bill approved", {
              "bill.id": approved.bill.id,
              "bill.number": approved.bill.number ?? undefined,
              "bill.total": approved.bill.total,
            });
            return view(approved.bill, approved.lines);
          },
          {
            params: IdParams,
            response: BillView,
            detail: { summary: "Approve a draft: assign the number and post Dr expense and VAT input, Cr payable" },
          },
        )
        .post(
          "/bills/:id/void",
          async ({ principal, params, body }) => {
            const voided = await tenant(principal, async (tx, organizationId) => {
              const { bill, lines } = await load(tx, params.id, true);
              if (bill.status !== "approved") throw new ConflictError("Only approved bills can be voided");
              if (toCents(bill.amountPaid) > 0n) throw new ConflictError("A bill with payments cannot be voided");
              const date = body?.date ?? today();
              if (date < bill.billDate) throw new UnprocessableError("The void date is before the bill date");
              const [updated] = await tx
                .update(bills)
                .set({ status: "void", voidedAt: new Date(), updatedAt: new Date() })
                .where(eq(bills.id, bill.id))
                .returning();
              await enqueue(tx, {
                organizationId,
                topic: TOPICS.reversal,
                payload: {
                  organizationId,
                  createdBy: principal.userId,
                  sourceId: bill.id,
                  date,
                  description: `Void bill ${bill.number}`,
                },
              });
              return { bill: updated as Bill, lines };
            });
            return view(voided.bill, voided.lines);
          },
          {
            params: IdParams,
            body: t.Optional(t.Object({ date: t.Optional(t.String({ format: "date" })) })),
            response: BillView,
            detail: { summary: "Void an unpaid approved bill; its journal is reversed on the void date" },
          },
        ),
    )
    .group("/internal/purchases/bills", (internal) =>
      internal.use(serviceAuthentication(context.verifyService, LOOKUP_CALLERS)).get(
        "/lookup",
        async ({ query }) => {
          const rows = await withTenant(db, query.organizationId, (tx) =>
            tx
              .select()
              .from(bills)
              .where(inArray(bills.id, [query.id].flat())),
          );
          return rows.map(documentView);
        },
        {
          query: t.Object({ organizationId: t.String({ format: "uuid" }), id: Ids }),
          response: t.Array(DocumentView),
          detail: { summary: "Bills with their amount due, for other services" },
        },
      ),
    )
    .group("/internal/purchases/allocations", (internal) =>
      internal
        .use(serviceAuthentication(context.verifyService, ALLOCATION_CALLERS))
        .post(
          "/",
          async ({ body }) =>
            withTenant(db, body.organizationId, async (tx) => {
              let applied = 0;
              for (const allocation of body.allocations) {
                const [inserted] = await tx
                  .insert(billPayments)
                  .values({
                    id: allocation.id,
                    billId: allocation.documentId,
                    organizationId: body.organizationId,
                    paymentId: body.paymentId,
                    amount: allocation.amount,
                  })
                  .onConflictDoNothing({ target: billPayments.id })
                  .returning({ id: billPayments.id });
                if (!inserted) continue;
                const [updated] = await tx
                  .update(bills)
                  .set({ amountPaid: sql`${bills.amountPaid} + ${allocation.amount}`, updatedAt: new Date() })
                  .where(
                    and(
                      eq(bills.id, allocation.documentId),
                      eq(bills.status, "approved"),
                      sql`${bills.amountPaid} + ${allocation.amount} <= ${bills.total}`,
                    ),
                  )
                  .returning({ id: bills.id });
                if (!updated) {
                  throw new UnprocessableError("The allocation exceeds the amount due or the bill is not approved", {
                    billId: allocation.documentId,
                  });
                }
                applied++;
              }
              return { applied };
            }),
          {
            body: t.Object({
              organizationId: t.String({ format: "uuid" }),
              paymentId: t.String({ format: "uuid" }),
              allocations: t.Array(
                t.Object({
                  id: t.String({ format: "uuid" }),
                  documentId: t.String({ format: "uuid" }),
                  amount: t.String({ pattern: AMOUNT_PATTERN }),
                }),
                { minItems: 1, maxItems: 200 },
              ),
            }),
            response: t.Object({ applied: t.Integer() }),
            detail: { summary: "Apply payment allocations to bills, once per allocation id" },
          },
        )
        .post(
          "/reverse",
          async ({ body }) =>
            withTenant(db, body.organizationId, async (tx) => {
              const reversed = await tx
                .update(billPayments)
                .set({ reversedAt: new Date() })
                .where(and(eq(billPayments.paymentId, body.paymentId), isNull(billPayments.reversedAt)))
                .returning({ billId: billPayments.billId, amount: billPayments.amount });
              for (const allocation of reversed) {
                await tx
                  .update(bills)
                  .set({ amountPaid: sql`${bills.amountPaid} - ${allocation.amount}`, updatedAt: new Date() })
                  .where(eq(bills.id, allocation.billId));
              }
              return { reversed: reversed.length };
            }),
          {
            body: t.Object({ organizationId: t.String({ format: "uuid" }), paymentId: t.String({ format: "uuid" }) }),
            response: t.Object({ reversed: t.Integer() }),
            detail: { summary: "Take back the allocations of a voided payment" },
          },
        ),
    );
}
