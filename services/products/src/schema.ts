import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  numeric,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const PRODUCT_KINDS = ["goods", "service"] as const;
export const productKind = pgEnum("product_kind", PRODUCT_KINDS);

const tenant = sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`;

export const products = pgTable(
  "products",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    sku: text().notNull(),
    name: text().notNull(),
    kind: productKind().notNull(),
    unit: text().notNull().default("pcs"),
    salePrice: numeric({ precision: 20, scale: 2 }),
    purchasePrice: numeric({ precision: 20, scale: 2 }),
    vatRate: numeric({ precision: 5, scale: 2 }).notNull().default("11"),
    revenueAccountId: uuid(),
    expenseAccountId: uuid(),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.organizationId, table.sku),
    check("products_prices", sql`coalesce(${table.salePrice}, 0) >= 0 and coalesce(${table.purchasePrice}, 0) >= 0`),
    check("products_vat_rate", sql`${table.vatRate} between 0 and 100`),
    pgPolicy("products_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const schema = { products };
export type Product = typeof products.$inferSelect;
