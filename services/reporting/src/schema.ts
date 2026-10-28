import { sql } from "drizzle-orm";
import { date, index, jsonb, pgEnum, pgPolicy, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { balanceSheet, incomeStatement } from "./statements";

export const STATEMENT_KINDS = ["income-statement", "balance-sheet"] as const;
export const statementKind = pgEnum("statement_kind", STATEMENT_KINDS);

const tenant = sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`;

export const statements = pgTable(
  "statements",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    kind: statementKind().notNull(),
    periodFrom: date({ mode: "string" }),
    periodTo: date({ mode: "string" }).notNull(),
    data: jsonb().$type<ReturnType<typeof incomeStatement> | ReturnType<typeof balanceSheet>>().notNull(),
    createdBy: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.organizationId, table.kind, table.periodTo),
    pgPolicy("statements_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export const schema = { statements };
export type Statement = typeof statements.$inferSelect;
