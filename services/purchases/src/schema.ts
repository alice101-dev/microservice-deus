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

export const BILL_STATUSES = ["draft", "approved", "void"] as const;
export const billStatus = pgEnum("bill_status", BILL_STATUSES);

const tenant = sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`;
const money = () => numeric({ precision: 20, scale: 2 });

export const bills = pgTable(
  "bills",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    number: text(),
    vendorReference: text(),
    contactId: uuid().notNull(),
    contactName: text().notNull(),
    status: billStatus().notNull().default("draft"),
    billDate: date({ mode: "string" }).notNull(),
    dueDate: date({ mode: "string" }).notNull(),
    notes: text(),
    subtotal: money().notNull(),
    vatTotal: money().notNull(),
    total: money().notNull(),
    amountPaid: money().notNull().default("0"),
    createdBy: uuid().notNull(),
    approvedAt: timestamp({ withTimezone: true }),
    voidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.organizationId, table.number).where(sql`${table.number} is not null`),
    uniqueIndex()
      .on(table.organizationId, table.contactId, table.vendorReference)
      .where(sql`${table.vendorReference} is not null`),
    index().on(table.organizationId, table.status, table.billDate),
    index().on(table.organizationId, table.contactId),
    check("bills_totals", sql`${table.total} = ${table.subtotal} + ${table.vatTotal}`),
    check("bills_paid", sql`${table.amountPaid} >= 0 and ${table.amountPaid} <= ${table.total}`),
    check("bills_due", sql`${table.dueDate} >= ${table.billDate}`),
    check("bills_number", sql`(${table.status} = 'draft') = (${table.number} is null)`),
    pgPolicy("bills_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const billLines = pgTable(
  "bill_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    billId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    organizationId: uuid().notNull(),
    lineNo: integer().notNull(),
    productId: uuid(),
    description: text().notNull(),
    quantity: numeric({ precision: 20, scale: 4 }).notNull(),
    unitPrice: money().notNull(),
    vatRate: numeric({ precision: 5, scale: 2 }).notNull(),
    amount: money().notNull(),
    vatAmount: money().notNull(),
    accountId: uuid().notNull(),
  },
  (table) => [
    uniqueIndex().on(table.billId, table.lineNo),
    check("bill_lines_positive", sql`${table.quantity} > 0 and ${table.unitPrice} >= 0`),
    pgPolicy("bill_lines_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const billSequences = pgTable(
  "bill_sequences",
  {
    organizationId: uuid().notNull(),
    year: integer().notNull(),
    last: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.year] }),
    pgPolicy("bill_sequences_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export { outbox };
export const schema = { bills, billLines, billSequences, outbox };
export type Bill = typeof bills.$inferSelect;
export type BillLine = typeof billLines.$inferSelect;
