import { outbox } from "@deus/outbox";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const LINE_STATUSES = ["unmatched", "matched", "posted", "ignored"] as const;
export const lineStatus = pgEnum("statement_line_status", LINE_STATUSES);

const tenant = sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`;
const money = () => numeric({ precision: 20, scale: 2 });

export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    name: text().notNull(),
    bankName: text().notNull(),
    accountNumber: text().notNull(),
    ledgerAccountId: uuid().notNull(),
    openingBalance: money().notNull().default("0"),
    openingDate: date({ mode: "string" }).notNull(),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.organizationId, table.ledgerAccountId),
    pgPolicy("bank_accounts_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const statementLines = pgTable(
  "statement_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    bankAccountId: uuid()
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "restrict" }),
    lineDate: date({ mode: "string" }).notNull(),
    description: text().notNull(),
    amount: money().notNull(),
    reference: text(),
    fingerprint: text().notNull(),
    status: lineStatus().notNull().default("unmatched"),
    paymentId: uuid(),
    counterAccountId: uuid(),
    resolvedBy: uuid(),
    resolvedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("statement_lines_fingerprint").on(table.organizationId, table.bankAccountId, table.fingerprint),
    uniqueIndex().on(table.organizationId, table.paymentId).where(sql`${table.paymentId} is not null`),
    index("statement_lines_open").on(table.organizationId, table.bankAccountId, table.status, table.lineDate),
    check("statement_lines_amount", sql`${table.amount} <> 0`),
    pgPolicy("statement_lines_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export { outbox };
export const schema = { bankAccounts, statementLines, outbox };
export type BankAccount = typeof bankAccounts.$inferSelect;
export type StatementLine = typeof statementLines.$inferSelect;
