import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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

const tenant = sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`;
const amount = () => numeric({ precision: 20, scale: 2 }).notNull().default("0");

export const journalStatus = pgEnum("journal_status", ["draft", "posted"]);

export const journals = pgTable(
  "journals",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    entryDate: date({ mode: "string" }).notNull(),
    description: text().notNull(),
    status: journalStatus().notNull().default("draft"),
    source: text().notNull().default("manual"),
    sourceId: text(),
    idempotencyKey: text(),
    requestHash: text(),
    reversalOf: uuid().references((): AnyPgColumn => journals.id, { onDelete: "restrict" }),
    createdBy: uuid().notNull(),
    postedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.organizationId, table.idempotencyKey).where(sql`${table.idempotencyKey} is not null`),
    uniqueIndex().on(table.reversalOf).where(sql`${table.reversalOf} is not null`),
    index().on(table.organizationId, table.entryDate),
    pgPolicy("journals_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    journalId: uuid()
      .notNull()
      .references(() => journals.id, { onDelete: "cascade" }),
    organizationId: uuid().notNull(),
    lineNo: integer().notNull(),
    accountId: uuid().notNull(),
    debit: amount(),
    credit: amount(),
    memo: text(),
  },
  (table) => [
    check(
      "journal_lines_one_side",
      sql`${table.debit} >= 0 and ${table.credit} >= 0 and (${table.debit} > 0) <> (${table.credit} > 0)`,
    ),
    uniqueIndex().on(table.journalId, table.lineNo),
    index().on(table.organizationId, table.accountId),
    pgPolicy("journal_lines_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const closedPeriods = pgTable(
  "closed_periods",
  {
    organizationId: uuid().notNull(),
    period: text().notNull(),
    closedBy: uuid().notNull(),
    closedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.period] }),
    check("closed_periods_format", sql`${table.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    pgPolicy("closed_periods_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const schema = { journals, journalLines, closedPeriods };
export type Journal = typeof journals.$inferSelect;
export type JournalLine = typeof journalLines.$inferSelect;
