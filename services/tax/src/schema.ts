import { outbox } from "@deus/outbox";
import { sql } from "drizzle-orm";
import { check, numeric, pgEnum, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const vatReturnStatus = pgEnum("vat_return_status", ["draft", "filed"]);

const tenant = sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`;
const money = () => numeric({ precision: 20, scale: 2 });

export const vatReturns = pgTable(
  "vat_returns",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    period: text().notNull(),
    outputVat: money().notNull(),
    inputVat: money().notNull(),
    payable: money().notNull(),
    carriedForward: money().notNull(),
    status: vatReturnStatus().notNull().default("draft"),
    createdBy: uuid().notNull(),
    filedBy: uuid(),
    filedAt: timestamp({ withTimezone: true }),
    calculatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.organizationId, table.period),
    check("vat_returns_period", sql`${table.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      "vat_returns_amounts",
      sql`${table.outputVat} >= 0 and ${table.inputVat} >= 0 and ${table.payable} >= 0 and ${table.carriedForward} >= 0`,
    ),
    pgPolicy("vat_returns_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export { outbox };
export const schema = { vatReturns, outbox };
export type VatReturn = typeof vatReturns.$inferSelect;
