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
import { type Database, type Transaction, withTenant } from "@deus/db";
import { addDays, lineAccountIds, priceLines, SALE_PRICING, today, trimQuantity } from "@deus/documents";
import { ConflictError, NotFoundError, UnprocessableError } from "@deus/errors";
import { createService } from "@deus/http";
import type { Logger } from "@deus/logger";
import { AMOUNT_PATTERN, fromCents, QUANTITY_PATTERN, RATE_PATTERN, toCents } from "@deus/money";
import { enqueue } from "@deus/outbox";
import { and, desc, eq, gte, inArray, isNull, lte, type SQL, sql } from "drizzle-orm";
import { t } from "elysia";
import { invoiceJournal, type SalesAccounts } from "./journal";
import {
  type Invoice,
  type InvoiceLine,
  invoiceLines,
  invoicePayments,
  invoiceSequences,
  invoices,
  type schema,
} from "./schema";

export const TOPICS = { journal: "ledger.journal", reversal: "ledger.reversal" } as const;
export const LOOKUP_CALLERS = ["payments", "reporting", "notification"] as const;
export const ALLOCATION_CALLERS = ["payments"] as const;

export interface SalesContext {
  config: BaseConfig;
  logger: Logger;
  db: Database<typeof schema>;
  verify: Verifier;
  verifyService: ServiceVerifier;
  accounts: Lookup<AccountRef>;
  accountsByCode: AccountsByCode;
  contacts: Lookup<ContactRef>;
  products: Lookup<ProductRef>;
  receivableAccountCode: string;
  vatOutputAccountCode: string;
  readiness?: Array<() => Promise<void>>;
}

type Tx = Transaction<typeof schema>;

const Status = t.Union([t.Literal("draft"), t.Literal("issued"), t.Literal("void")]);
const LineBody = t.Object({
  productId: t.Optional(t.String({ format: "uuid" })),
  description: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
  quantity: t.String({ pattern: QUANTITY_PATTERN }),
  unitPrice: t.Optional(t.String({ pattern: AMOUNT_PATTERN })),
  vatRate: t.Optional(t.String({ pattern: RATE_PATTERN })),
  revenueAccountId: t.Optional(t.String({ format: "uuid" })),
});
const DraftBody = t.Object({
  contactId: t.String({ format: "uuid" }),
  issueDate: t.String({ format: "date" }),
  dueDate: t.Optional(t.String({ format: "date" })),
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
  revenueAccountId: t.String(),
});
const InvoiceView = t.Object({
  id: t.String(),
  number: t.Nullable(t.String()),
  status: Status,
  contactId: t.String(),
  contactName: t.String(),
  issueDate: t.String(),
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
const documentView = (invoice: Invoice) => ({
  id: invoice.id,
  number: invoice.number,
  status: invoice.status,
  contactId: invoice.contactId,
  contactName: invoice.contactName,
  date: invoice.issueDate,
  dueDate: invoice.dueDate,
  total: invoice.total,
  amountPaid: invoice.amountPaid,
  amountDue: fromCents(toCents(invoice.total) - toCents(invoice.amountPaid)),
});
const Ids = t.Union([
  t.String({ format: "uuid" }),
  t.Array(t.String({ format: "uuid" }), { minItems: 1, maxItems: 200 }),
]);

function view(invoice: Invoice, lines: InvoiceLine[]) {
  const due = toCents(invoice.total) - toCents(invoice.amountPaid);
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    contactId: invoice.contactId,
    contactName: invoice.contactName,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    notes: invoice.notes,
    subtotal: invoice.subtotal,
    vatTotal: invoice.vatTotal,
    total: invoice.total,
    amountPaid: invoice.amountPaid,
    amountDue: invoice.status === "void" ? "0.00" : fromCents(due),
    paymentStatus: paymentStatus(invoice.total, invoice.amountPaid),
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
        revenueAccountId: line.revenueAccountId,
      })),
  };
}

async function load(tx: Tx, id: string, lock = false) {
  const query = tx.select().from(invoices).where(eq(invoices.id, id));
  const [invoice] = await (lock ? query.for("update") : query);
  if (!invoice) throw new NotFoundError("The invoice does not exist");
  const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
  return { invoice, lines };
}

async function nextNumber(tx: Tx, organizationId: string, year: number) {
  const [row] = await tx
    .insert(invoiceSequences)
    .values({ organizationId, year, last: 1 })
    .onConflictDoUpdate({
      target: [invoiceSequences.organizationId, invoiceSequences.year],
      set: { last: sql`${invoiceSequences.last} + 1` },
    })
    .returning({ last: invoiceSequences.last });
  return `INV/${year}/${String(row?.last ?? 1).padStart(4, "0")}`;
}

export function createApp(context: SalesContext) {
  const { db } = context;

  const resolveDraft = async (organizationId: string, body: typeof DraftBody.static) => {
    const [contact] = await context.contacts([body.contactId], organizationId);
    if (!contact?.active || !contact.isCustomer) {
      throw new UnprocessableError("The contact must be an active customer", { contactId: body.contactId });
    }
    const productIds = body.lines.flatMap((line) => (line.productId ? [line.productId] : []));
    const products = new Map(
      (productIds.length ? await context.products(productIds, organizationId) : []).map((product) => [
        product.id,
        product,
      ]),
    );
    const lines = body.lines.map(({ revenueAccountId, ...line }) => ({ ...line, accountId: revenueAccountId }));
    const accountIds = lineAccountIds(lines, products, SALE_PRICING);
    const accounts = new Map(
      (accountIds.length ? await context.accounts(accountIds, organizationId) : []).map((account) => [
        account.id,
        account,
      ]),
    );
    const priced = priceLines(lines, products, accounts, SALE_PRICING);
    const dueDate = body.dueDate ?? addDays(body.issueDate, contact.paymentTermsDays);
    if (dueDate < body.issueDate) throw new UnprocessableError("The due date is before the issue date");
    return { contact, priced, dueDate };
  };

  const salesAccounts = async (organizationId: string): Promise<SalesAccounts> => {
    const codes = [context.receivableAccountCode, context.vatOutputAccountCode];
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
      receivable: pick(context.receivableAccountCode, "asset"),
      vatOutput: pick(context.vatOutputAccountCode, "liability"),
    };
  };

  const writeLines = (
    tx: Tx,
    organizationId: string,
    invoiceId: string,
    lines: ReturnType<typeof priceLines>["lines"],
  ) =>
    tx
      .insert(invoiceLines)
      .values(
        lines.map(({ accountId, ...line }) => ({ ...line, revenueAccountId: accountId, invoiceId, organizationId })),
      );

  const tenant = <T>(principal: Principal, work: (tx: Tx, organizationId: string) => Promise<T>) => {
    const organizationId = requireOrganization(principal);
    return withTenant(db, organizationId, (tx) => work(tx, organizationId));
  };

  return createService({ config: context.config, logger: context.logger, readiness: context.readiness })
    .group("/api/sales", (api) =>
      api
        .use(authentication(context.verify))
        .post(
          "/invoices",
          async ({ principal, body, set }) => {
            const organizationId = requireOrganization(principal);
            const { contact, priced, dueDate } = await resolveDraft(organizationId, body);
            const created = await withTenant(db, organizationId, async (tx) => {
              const [invoice] = await tx
                .insert(invoices)
                .values({
                  organizationId,
                  contactId: contact.id,
                  contactName: contact.name,
                  issueDate: body.issueDate,
                  dueDate,
                  notes: body.notes ?? null,
                  subtotal: priced.subtotal,
                  vatTotal: priced.vatTotal,
                  total: priced.total,
                  createdBy: principal.userId,
                })
                .returning();
              const id = (invoice as Invoice).id;
              await writeLines(tx, organizationId, id, priced.lines);
              return load(tx, id);
            });
            set.status = 201;
            return view(created.invoice, created.lines);
          },
          {
            body: DraftBody,
            response: { 201: InvoiceView },
            detail: { summary: "Create a draft invoice; lines default to the product's name, price, VAT and account" },
          },
        )
        .get(
          "/invoices",
          async ({ principal, query }) =>
            tenant(principal, async (tx) => {
              const conditions: SQL[] = [];
              if (query.status) conditions.push(eq(invoices.status, query.status));
              if (query.contactId) conditions.push(eq(invoices.contactId, query.contactId));
              if (query.from) conditions.push(gte(invoices.issueDate, query.from));
              if (query.to) conditions.push(lte(invoices.issueDate, query.to));
              const rows = await tx
                .select()
                .from(invoices)
                .where(and(...conditions))
                .orderBy(desc(invoices.issueDate), desc(invoices.createdAt))
                .limit(200);
              const lines = rows.length
                ? await tx
                    .select()
                    .from(invoiceLines)
                    .where(sql`${invoiceLines.invoiceId} in ${rows.map((row) => row.id)}`)
                : [];
              return rows.map((row) =>
                view(
                  row,
                  lines.filter((line) => line.invoiceId === row.id),
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
            response: t.Array(InvoiceView),
            detail: { summary: "Invoices of the active organization, newest first (at most 200)" },
          },
        )
        .get(
          "/invoices/:id",
          async ({ principal, params }) => {
            const loaded = await tenant(principal, (tx) => load(tx, params.id));
            return view(loaded.invoice, loaded.lines);
          },
          { params: IdParams, response: InvoiceView, detail: { summary: "One invoice" } },
        )
        .put(
          "/invoices/:id",
          async ({ principal, params, body }) => {
            const organizationId = requireOrganization(principal);
            const { contact, priced, dueDate } = await resolveDraft(organizationId, body);
            const updated = await withTenant(db, organizationId, async (tx) => {
              const { invoice } = await load(tx, params.id, true);
              if (invoice.status !== "draft") throw new ConflictError("Only draft invoices can be changed");
              await tx
                .update(invoices)
                .set({
                  contactId: contact.id,
                  contactName: contact.name,
                  issueDate: body.issueDate,
                  dueDate,
                  notes: body.notes ?? null,
                  subtotal: priced.subtotal,
                  vatTotal: priced.vatTotal,
                  total: priced.total,
                  updatedAt: new Date(),
                })
                .where(eq(invoices.id, invoice.id));
              await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id));
              await writeLines(tx, organizationId, invoice.id, priced.lines);
              return load(tx, invoice.id);
            });
            return view(updated.invoice, updated.lines);
          },
          { params: IdParams, body: DraftBody, response: InvoiceView, detail: { summary: "Replace a draft invoice" } },
        )
        .delete(
          "/invoices/:id",
          async ({ principal, params, set }) => {
            await tenant(principal, async (tx) => {
              const { invoice } = await load(tx, params.id, true);
              if (invoice.status !== "draft")
                throw new ConflictError("Only draft invoices can be deleted; void it instead");
              await tx.delete(invoices).where(eq(invoices.id, invoice.id));
            });
            set.status = 204;
          },
          { params: IdParams, detail: { summary: "Delete a draft invoice" } },
        )
        .post(
          "/invoices/:id/issue",
          async ({ principal, params }) => {
            const organizationId = requireOrganization(principal);
            const accounts = await salesAccounts(organizationId);
            const issued = await withTenant(db, organizationId, async (tx) => {
              const { invoice, lines } = await load(tx, params.id, true);
              if (invoice.status !== "draft") throw new ConflictError(`The invoice is already ${invoice.status}`);
              if (toCents(invoice.total) === 0n)
                throw new UnprocessableError("An invoice without an amount cannot be issued");
              const number = await nextNumber(tx, organizationId, Number(invoice.issueDate.slice(0, 4)));
              const [updated] = await tx
                .update(invoices)
                .set({ status: "issued", number, issuedAt: new Date(), updatedAt: new Date() })
                .where(eq(invoices.id, invoice.id))
                .returning();
              await enqueue(tx, {
                organizationId,
                topic: TOPICS.journal,
                payload: invoiceJournal(updated as Invoice, lines, accounts),
              });
              return { invoice: updated as Invoice, lines };
            });
            context.logger.info("invoice issued", {
              "invoice.id": issued.invoice.id,
              "invoice.number": issued.invoice.number ?? undefined,
              "invoice.total": issued.invoice.total,
            });
            return view(issued.invoice, issued.lines);
          },
          {
            params: IdParams,
            response: InvoiceView,
            detail: { summary: "Issue a draft: assign the number and post Dr receivable, Cr revenue and VAT output" },
          },
        )
        .post(
          "/invoices/:id/void",
          async ({ principal, params, body }) => {
            const voided = await tenant(principal, async (tx, organizationId) => {
              const { invoice, lines } = await load(tx, params.id, true);
              if (invoice.status !== "issued") throw new ConflictError("Only issued invoices can be voided");
              if (toCents(invoice.amountPaid) > 0n)
                throw new ConflictError("An invoice with payments cannot be voided");
              const date = body?.date ?? today();
              if (date < invoice.issueDate) throw new UnprocessableError("The void date is before the issue date");
              const [updated] = await tx
                .update(invoices)
                .set({ status: "void", voidedAt: new Date(), updatedAt: new Date() })
                .where(eq(invoices.id, invoice.id))
                .returning();
              await enqueue(tx, {
                organizationId,
                topic: TOPICS.reversal,
                payload: {
                  organizationId,
                  createdBy: principal.userId,
                  sourceId: invoice.id,
                  date,
                  description: `Void invoice ${invoice.number}`,
                },
              });
              return { invoice: updated as Invoice, lines };
            });
            return view(voided.invoice, voided.lines);
          },
          {
            params: IdParams,
            body: t.Optional(t.Object({ date: t.Optional(t.String({ format: "date" })) })),
            response: InvoiceView,
            detail: { summary: "Void an unpaid issued invoice; its journal is reversed on the void date" },
          },
        ),
    )
    .group("/internal/sales/invoices", (internal) =>
      internal.use(serviceAuthentication(context.verifyService, LOOKUP_CALLERS)).get(
        "/lookup",
        async ({ query }) => {
          const rows = await withTenant(db, query.organizationId, (tx) =>
            tx
              .select()
              .from(invoices)
              .where(inArray(invoices.id, [query.id].flat())),
          );
          return rows.map(documentView);
        },
        {
          query: t.Object({ organizationId: t.String({ format: "uuid" }), id: Ids }),
          response: t.Array(DocumentView),
          detail: { summary: "Invoices with their amount due, for other services" },
        },
      ),
    )
    .group("/internal/sales/allocations", (internal) =>
      internal
        .use(serviceAuthentication(context.verifyService, ALLOCATION_CALLERS))
        .post(
          "/",
          async ({ body }) =>
            withTenant(db, body.organizationId, async (tx) => {
              let applied = 0;
              for (const allocation of body.allocations) {
                const [inserted] = await tx
                  .insert(invoicePayments)
                  .values({
                    id: allocation.id,
                    invoiceId: allocation.documentId,
                    organizationId: body.organizationId,
                    paymentId: body.paymentId,
                    amount: allocation.amount,
                  })
                  .onConflictDoNothing({ target: invoicePayments.id })
                  .returning({ id: invoicePayments.id });
                if (!inserted) continue;
                const [updated] = await tx
                  .update(invoices)
                  .set({ amountPaid: sql`${invoices.amountPaid} + ${allocation.amount}`, updatedAt: new Date() })
                  .where(
                    and(
                      eq(invoices.id, allocation.documentId),
                      eq(invoices.status, "issued"),
                      sql`${invoices.amountPaid} + ${allocation.amount} <= ${invoices.total}`,
                    ),
                  )
                  .returning({ id: invoices.id });
                if (!updated) {
                  throw new UnprocessableError("The allocation exceeds the amount due or the invoice is not issued", {
                    invoiceId: allocation.documentId,
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
            detail: { summary: "Apply payment allocations to invoices, once per allocation id" },
          },
        )
        .post(
          "/reverse",
          async ({ body }) =>
            withTenant(db, body.organizationId, async (tx) => {
              const reversed = await tx
                .update(invoicePayments)
                .set({ reversedAt: new Date() })
                .where(and(eq(invoicePayments.paymentId, body.paymentId), isNull(invoicePayments.reversedAt)))
                .returning({ invoiceId: invoicePayments.invoiceId, amount: invoicePayments.amount });
              for (const allocation of reversed) {
                await tx
                  .update(invoices)
                  .set({ amountPaid: sql`${invoices.amountPaid} - ${allocation.amount}`, updatedAt: new Date() })
                  .where(eq(invoices.id, allocation.invoiceId));
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
