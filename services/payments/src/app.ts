import { authentication, type Principal, requireOrganization, type Verifier } from "@deus/auth";
import type { AccountRef, AccountsByCode, ContactRef, DocumentRef, JournalRequest, Lookup } from "@deus/clients";
import type { BaseConfig } from "@deus/config";
import { type Database, type Transaction, withTenant } from "@deus/db";
import { documentNumber, today } from "@deus/documents";
import { ConflictError, NotFoundError, UnprocessableError } from "@deus/errors";
import { createService } from "@deus/http";
import type { Logger } from "@deus/logger";
import { AMOUNT_PATTERN, normalize, sum, toCents } from "@deus/money";
import { enqueue } from "@deus/outbox";
import { and, desc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import { t } from "elysia";
import {
  type Payment,
  type PaymentAllocation,
  paymentAllocations,
  paymentSequences,
  payments,
  type schema,
} from "./schema";

export const TOPICS = {
  journal: "ledger.journal",
  reversal: "ledger.reversal",
  salesAllocations: "sales.allocations",
  salesAllocationsReverse: "sales.allocations.reverse",
  purchasesAllocations: "purchases.allocations",
  purchasesAllocationsReverse: "purchases.allocations.reverse",
} as const;

type Kind = "receipt" | "disbursement";

const KINDS: Record<
  Kind,
  {
    prefix: string;
    role: "isCustomer" | "isVendor";
    documentStatus: string;
    apply: string;
    reverse: string;
    label: string;
  }
> = {
  receipt: {
    prefix: "RCV",
    role: "isCustomer",
    documentStatus: "issued",
    apply: TOPICS.salesAllocations,
    reverse: TOPICS.salesAllocationsReverse,
    label: "invoice",
  },
  disbursement: {
    prefix: "PAY",
    role: "isVendor",
    documentStatus: "approved",
    apply: TOPICS.purchasesAllocations,
    reverse: TOPICS.purchasesAllocationsReverse,
    label: "bill",
  },
};

export interface PaymentsContext {
  config: BaseConfig;
  logger: Logger;
  db: Database<typeof schema>;
  verify: Verifier;
  accounts: Lookup<AccountRef>;
  accountsByCode: AccountsByCode;
  contacts: Lookup<ContactRef>;
  invoices: Lookup<DocumentRef>;
  bills: Lookup<DocumentRef>;
  receivableAccountCode: string;
  payableAccountCode: string;
  readiness?: Array<() => Promise<void>>;
}

type Tx = Transaction<typeof schema>;

const Kind = t.Union([t.Literal("receipt"), t.Literal("disbursement")]);
const Amount = t.String({ pattern: AMOUNT_PATTERN });
const PaymentBody = t.Object({
  kind: Kind,
  contactId: t.String({ format: "uuid" }),
  date: t.String({ format: "date" }),
  cashAccountId: t.String({ format: "uuid" }),
  amount: Amount,
  reference: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  notes: t.Optional(t.String({ maxLength: 2000 })),
  allocations: t.Array(t.Object({ documentId: t.String({ format: "uuid" }), amount: Amount }), {
    minItems: 1,
    maxItems: 100,
  }),
});
const PaymentView = t.Object({
  id: t.String(),
  number: t.String(),
  kind: Kind,
  status: t.Union([t.Literal("recorded"), t.Literal("void")]),
  contactId: t.String(),
  contactName: t.String(),
  date: t.String(),
  cashAccountId: t.String(),
  amount: t.String(),
  reference: t.Nullable(t.String()),
  notes: t.Nullable(t.String()),
  allocations: t.Array(t.Object({ documentId: t.String(), documentNumber: t.String(), amount: t.String() })),
});
const IdParams = t.Object({ id: t.String({ format: "uuid" }) });

function view(payment: Payment, allocations: PaymentAllocation[]) {
  return {
    id: payment.id,
    number: payment.number,
    kind: payment.kind,
    status: payment.status,
    contactId: payment.contactId,
    contactName: payment.contactName,
    date: payment.paymentDate,
    cashAccountId: payment.cashAccountId,
    amount: payment.amount,
    reference: payment.reference,
    notes: payment.notes,
    allocations: allocations.map((allocation) => ({
      documentId: allocation.documentId,
      documentNumber: allocation.documentNumber,
      amount: allocation.amount,
    })),
  };
}

async function load(tx: Tx, id: string, lock = false) {
  const query = tx.select().from(payments).where(eq(payments.id, id));
  const [payment] = await (lock ? query.for("update") : query);
  if (!payment) throw new NotFoundError("The payment does not exist");
  const allocations = await tx.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, id));
  return { payment, allocations };
}

async function nextNumber(tx: Tx, organizationId: string, kind: Kind, year: number) {
  const [row] = await tx
    .insert(paymentSequences)
    .values({ organizationId, kind, year, last: 1 })
    .onConflictDoUpdate({
      target: [paymentSequences.organizationId, paymentSequences.kind, paymentSequences.year],
      set: { last: sql`${paymentSequences.last} + 1` },
    })
    .returning({ last: paymentSequences.last });
  return documentNumber(KINDS[kind].prefix, year, row?.last ?? 1);
}

export function paymentJournal(
  payment: Payment,
  allocations: readonly PaymentAllocation[],
  counterAccountId: string,
): JournalRequest {
  const numbers = allocations.map((allocation) => allocation.documentNumber).join(", ");
  const cash = { accountId: payment.cashAccountId, memo: payment.reference ?? payment.number };
  const counter = { accountId: counterAccountId, memo: numbers };
  return {
    organizationId: payment.organizationId,
    createdBy: payment.createdBy,
    date: payment.paymentDate,
    description: `${payment.kind === "receipt" ? "Receipt" : "Payment"} ${payment.number} - ${payment.contactName}`,
    sourceId: payment.id,
    lines:
      payment.kind === "receipt"
        ? [
            { ...cash, debit: payment.amount },
            { ...counter, credit: payment.amount },
          ]
        : [
            { ...counter, debit: payment.amount },
            { ...cash, credit: payment.amount },
          ],
  };
}

export function createApp(context: PaymentsContext) {
  const { db } = context;

  const tenant = <T>(principal: Principal, work: (tx: Tx, organizationId: string) => Promise<T>) => {
    const organizationId = requireOrganization(principal);
    return withTenant(db, organizationId, (tx) => work(tx, organizationId));
  };

  const validate = async (organizationId: string, body: typeof PaymentBody.static) => {
    const rules = KINDS[body.kind];
    const [contact] = await context.contacts([body.contactId], organizationId);
    if (!contact?.active || !contact[rules.role]) {
      throw new UnprocessableError(
        `The contact must be an active ${rules.role === "isCustomer" ? "customer" : "vendor"}`,
      );
    }
    const [cash] = await context.accounts([body.cashAccountId], organizationId);
    if (!cash?.active || !cash.postable || cash.type !== "asset") {
      throw new UnprocessableError("The cash account must be an active asset account without sub-accounts");
    }
    const counterCode = body.kind === "receipt" ? context.receivableAccountCode : context.payableAccountCode;
    const counter = (await context.accountsByCode([counterCode], organizationId)).find(
      (entry) => entry.code === counterCode,
    );
    if (!counter?.active || !counter.postable) {
      throw new UnprocessableError(`Account ${counterCode} must exist as an active account without sub-accounts`);
    }
    const ids = body.allocations.map((allocation) => allocation.documentId);
    if (new Set(ids).size !== ids.length) throw new UnprocessableError(`Each ${rules.label} may be allocated once`);
    const lookup = body.kind === "receipt" ? context.invoices : context.bills;
    const documents = new Map((await lookup(ids, organizationId)).map((document) => [document.id, document]));
    const allocations = body.allocations.map((allocation, index) => {
      const document = documents.get(allocation.documentId);
      const fail = (message: string) =>
        new UnprocessableError(`Allocation ${index + 1}: ${message}`, { documentId: allocation.documentId });
      if (!document || document.status !== rules.documentStatus)
        throw fail(`the ${rules.label} is not ${rules.documentStatus}`);
      if (document.contactId !== body.contactId) throw fail(`the ${rules.label} belongs to another contact`);
      if (toCents(allocation.amount) <= 0n) throw fail("the amount must be greater than zero");
      if (toCents(allocation.amount) > toCents(document.amountDue)) {
        throw fail(`the amount exceeds the ${document.amountDue} due on ${document.number}`);
      }
      return {
        documentId: document.id,
        documentNumber: document.number ?? document.id,
        amount: normalize(allocation.amount),
      };
    });
    if (sum(allocations.map((allocation) => allocation.amount)) !== toCents(body.amount)) {
      throw new UnprocessableError("The allocations must add up to the payment amount");
    }
    return { contact, counterAccountId: counter.id, allocations };
  };

  return createService({ config: context.config, logger: context.logger, readiness: context.readiness }).group(
    "/api/payments",
    (api) =>
      api
        .use(authentication(context.verify))
        .post(
          "/",
          async ({ principal, body, set }) => {
            const organizationId = requireOrganization(principal);
            const { contact, counterAccountId, allocations } = await validate(organizationId, body);
            const rules = KINDS[body.kind];
            const recorded = await withTenant(db, organizationId, async (tx) => {
              const number = await nextNumber(tx, organizationId, body.kind, Number(body.date.slice(0, 4)));
              const [payment] = (await tx
                .insert(payments)
                .values({
                  organizationId,
                  number,
                  kind: body.kind,
                  contactId: contact.id,
                  contactName: contact.name,
                  paymentDate: body.date,
                  cashAccountId: body.cashAccountId,
                  amount: normalize(body.amount),
                  reference: body.reference ?? null,
                  notes: body.notes ?? null,
                  createdBy: principal.userId,
                })
                .returning()) as [Payment];
              const rows = await tx
                .insert(paymentAllocations)
                .values(allocations.map((allocation) => ({ ...allocation, organizationId, paymentId: payment.id })))
                .returning();
              await enqueue(tx, {
                organizationId,
                topic: TOPICS.journal,
                payload: paymentJournal(payment, rows, counterAccountId),
              });
              await enqueue(tx, {
                organizationId,
                topic: rules.apply,
                payload: {
                  organizationId,
                  paymentId: payment.id,
                  allocations: rows.map((row) => ({ id: row.id, documentId: row.documentId, amount: row.amount })),
                },
              });
              return { payment, allocations: rows };
            });
            context.logger.info("payment recorded", {
              "payment.id": recorded.payment.id,
              "payment.number": recorded.payment.number,
              "payment.kind": recorded.payment.kind,
              "payment.amount": recorded.payment.amount,
            });
            set.status = 201;
            return view(recorded.payment, recorded.allocations);
          },
          {
            body: PaymentBody,
            response: { 201: PaymentView },
            detail: {
              summary:
                "Record a customer receipt or a vendor payment, fully allocated to issued invoices or approved bills",
            },
          },
        )
        .get(
          "/",
          async ({ principal, query }) =>
            tenant(principal, async (tx) => {
              const conditions: SQL[] = [];
              if (query.kind) conditions.push(eq(payments.kind, query.kind));
              if (query.contactId) conditions.push(eq(payments.contactId, query.contactId));
              if (query.from) conditions.push(gte(payments.paymentDate, query.from));
              if (query.to) conditions.push(lte(payments.paymentDate, query.to));
              const rows = await tx
                .select()
                .from(payments)
                .where(and(...conditions))
                .orderBy(desc(payments.paymentDate), desc(payments.createdAt))
                .limit(200);
              const allocations = rows.length
                ? await tx
                    .select()
                    .from(paymentAllocations)
                    .where(
                      inArray(
                        paymentAllocations.paymentId,
                        rows.map((row) => row.id),
                      ),
                    )
                : [];
              return rows.map((row) =>
                view(
                  row,
                  allocations.filter((allocation) => allocation.paymentId === row.id),
                ),
              );
            }),
          {
            query: t.Object({
              kind: t.Optional(Kind),
              contactId: t.Optional(t.String({ format: "uuid" })),
              from: t.Optional(t.String({ format: "date" })),
              to: t.Optional(t.String({ format: "date" })),
            }),
            response: t.Array(PaymentView),
            detail: { summary: "Payments of the active organization, newest first (at most 200)" },
          },
        )
        .get(
          "/:id",
          async ({ principal, params }) => {
            const loaded = await tenant(principal, (tx) => load(tx, params.id));
            return view(loaded.payment, loaded.allocations);
          },
          { params: IdParams, response: PaymentView, detail: { summary: "One payment" } },
        )
        .post(
          "/:id/void",
          async ({ principal, params, body }) => {
            const voided = await tenant(principal, async (tx, organizationId) => {
              const { payment, allocations } = await load(tx, params.id, true);
              if (payment.status !== "recorded") throw new ConflictError("The payment is already void");
              const date = body?.date ?? today();
              if (date < payment.paymentDate) throw new UnprocessableError("The void date is before the payment date");
              const [updated] = (await tx
                .update(payments)
                .set({ status: "void", voidedAt: new Date() })
                .where(eq(payments.id, payment.id))
                .returning()) as [Payment];
              await enqueue(tx, {
                organizationId,
                topic: TOPICS.reversal,
                payload: {
                  organizationId,
                  createdBy: principal.userId,
                  sourceId: payment.id,
                  date,
                  description: `Void ${payment.number}`,
                },
              });
              await enqueue(tx, {
                organizationId,
                topic: KINDS[payment.kind].reverse,
                payload: { organizationId, paymentId: payment.id },
              });
              return { payment: updated, allocations };
            });
            return view(voided.payment, voided.allocations);
          },
          {
            params: IdParams,
            body: t.Optional(t.Object({ date: t.Optional(t.String({ format: "date" })) })),
            response: PaymentView,
            detail: { summary: "Void a payment: its journal is reversed and the documents owe the amount again" },
          },
        ),
  );
}
