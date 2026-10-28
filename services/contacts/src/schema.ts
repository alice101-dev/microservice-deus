import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const tenant = sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`;

export const contacts = pgTable(
  "contacts",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    name: text().notNull(),
    isCustomer: boolean().notNull().default(false),
    isVendor: boolean().notNull().default(false),
    email: text(),
    phone: text(),
    taxId: text(),
    address: text(),
    paymentTermsDays: integer().notNull().default(30),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.organizationId, table.name),
    check("contacts_role", sql`${table.isCustomer} or ${table.isVendor}`),
    check("contacts_tax_id_digits", sql`${table.taxId} is null or ${table.taxId} ~ '^[0-9]{15,16}$'`),
    check("contacts_payment_terms", sql`${table.paymentTermsDays} between 0 and 365`),
    pgPolicy("contacts_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const schema = { contacts };
export type Contact = typeof contacts.$inferSelect;
