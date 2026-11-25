import { outbox } from "@deus/outbox";
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const INVOICE_STATUSES = ["draft", "issued", "void"] as const;
export const invoiceStatus = pgEnum("invoice_status", INVOICE_STATUSES);

const tenant = sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`;
const money = () => numeric({ precision: 20, scale: 2 });

export const invoices = pgTable(
  "invoices",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    number: text(),
    contactId: uuid().notNull(),
    contactName: text().notNull(),
    status: invoiceStatus().notNull().default("draft"),
    issueDate: date({ mode: "string" }).notNull(),
    dueDate: date({ mode: "string" }).notNull(),
    notes: text(),
    subtotal: money().notNull(),
    vatTotal: money().notNull(),
    total: money().notNull(),
    amountPaid: money().notNull().default("0"),
    createdBy: uuid().notNull(),
    issuedAt: timestamp({ withTimezone: true }),
    voidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.organizationId, table.number).where(sql`${table.number} is not null`),
    index().on(table.organizationId, table.status, table.issueDate),
    index().on(table.organizationId, table.contactId),
    check("invoices_totals", sql`${table.total} = ${table.subtotal} + ${table.vatTotal}`),
    check("invoices_paid", sql`${table.amountPaid} >= 0 and ${table.amountPaid} <= ${table.total}`),
    check("invoices_due", sql`${table.dueDate} >= ${table.issueDate}`),
    check("invoices_number", sql`(${table.status} = 'draft') = (${table.number} is null)`),
    pgPolicy("invoices_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    organizationId: uuid().notNull(),
    lineNo: integer().notNull(),
    productId: uuid(),
    description: text().notNull(),
    quantity: numeric({ precision: 20, scale: 4 }).notNull(),
    unitPrice: money().notNull(),
    vatRate: numeric({ precision: 5, scale: 2 }).notNull(),
    amount: money().notNull(),
    vatAmount: money().notNull(),
    revenueAccountId: uuid().notNull(),
  },
  (table) => [
    uniqueIndex().on(table.invoiceId, table.lineNo),
    check("invoice_lines_positive", sql`${table.quantity} > 0 and ${table.unitPrice} >= 0`),
    pgPolicy("invoice_lines_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const invoicePayments = pgTable(
  "invoice_payments",
  {
    id: uuid().primaryKey(),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    organizationId: uuid().notNull(),
    paymentId: uuid().notNull(),
    amount: money().notNull(),
    appliedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    reversedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    index().on(table.organizationId, table.paymentId),
    index().on(table.invoiceId),
    check("invoice_payments_positive", sql`${table.amount} > 0`),
    pgPolicy("invoice_payments_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const invoiceSequences = pgTable(
  "invoice_sequences",
  {
    organizationId: uuid().notNull(),
    year: integer().notNull(),
    last: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.year] }),
    pgPolicy("invoice_sequences_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export { outbox };
export const schema = { invoices, invoiceLines, invoicePayments, invoiceSequences, outbox };
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
