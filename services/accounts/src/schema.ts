import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
export const accountType = pgEnum("account_type", ACCOUNT_TYPES);

const tenant = sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`;

export const accounts = pgTable(
  "accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    code: text().notNull(),
    name: text().notNull(),
    type: accountType().notNull(),
    parentId: uuid().references((): AnyPgColumn => accounts.id, { onDelete: "restrict" }),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.organizationId, table.code),
    index().on(table.organizationId, table.parentId),
    pgPolicy("accounts_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const schema = { accounts };
export type Account = typeof accounts.$inferSelect;
