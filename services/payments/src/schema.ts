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

export const PAYMENT_KINDS = ["receipt", "disbursement"] as const;
export const paymentKind = pgEnum("payment_kind", PAYMENT_KINDS);
export const paymentStatus = pgEnum("payment_status", ["recorded", "void"]);

const tenant = sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`;
const money = () => numeric({ precision: 20, scale: 2 });

export const payments = pgTable(
  "payments",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    number: text().notNull(),
    kind: paymentKind().notNull(),
    status: paymentStatus().notNull().default("recorded"),
    contactId: uuid().notNull(),
    contactName: text().notNull(),
    paymentDate: date({ mode: "string" }).notNull(),
    cashAccountId: uuid().notNull(),
    amount: money().notNull(),
    reference: text(),
    notes: text(),
    createdBy: uuid().notNull(),
    voidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.organizationId, table.number),
    index().on(table.organizationId, table.kind, table.paymentDate),
    index().on(table.organizationId, table.contactId),
    check("payments_positive", sql`${table.amount} > 0`),
    pgPolicy("payments_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: uuid().primaryKey().defaultRandom(),
    paymentId: uuid()
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    organizationId: uuid().notNull(),
    documentId: uuid().notNull(),
    documentNumber: text().notNull(),
    amount: money().notNull(),
  },
  (table) => [
    uniqueIndex().on(table.paymentId, table.documentId),
    index().on(table.organizationId, table.documentId),
    check("payment_allocations_positive", sql`${table.amount} > 0`),
    pgPolicy("payment_allocations_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const paymentSequences = pgTable(
  "payment_sequences",
  {
    organizationId: uuid().notNull(),
    kind: paymentKind().notNull(),
    year: integer().notNull(),
    last: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.kind, table.year] }),
    pgPolicy("payment_sequences_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export { outbox };
export const schema = { payments, paymentAllocations, paymentSequences, outbox };
export type Payment = typeof payments.$inferSelect;
export type PaymentAllocation = typeof paymentAllocations.$inferSelect;
