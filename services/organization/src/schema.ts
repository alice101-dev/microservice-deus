import { sql } from "drizzle-orm";
import { check, pgPolicy, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

const tenant = sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`;

export const profiles = pgTable(
  "profiles",
  {
    organizationId: uuid().primaryKey(),
    legalName: text().notNull(),
    taxId: text(),
    address: text(),
    currency: text().notNull().default("IDR"),
    fiscalYearStartMonth: smallint().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("profiles_currency_idr", sql`${table.currency} = 'IDR'`),
    check("profiles_fiscal_month", sql`${table.fiscalYearStartMonth} between 1 and 12`),
    check("profiles_tax_id_digits", sql`${table.taxId} is null or ${table.taxId} ~ '^[0-9]{15,16}$'`),
    pgPolicy("profiles_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const schema = { profiles };
export type Profile = typeof profiles.$inferSelect;
