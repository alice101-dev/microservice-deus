import { outbox } from "@deus/outbox";
import { sql } from "drizzle-orm";
import { jsonb, pgEnum, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const messageStatus = pgEnum("message_status", ["queued", "sent"]);

const tenant = sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`;

export const messages = pgTable(
  "messages",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    template: text().notNull(),
    recipient: text().notNull(),
    subject: text(),
    data: jsonb().notNull(),
    status: messageStatus().notNull().default("queued"),
    sourceService: text().notNull(),
    sourceKey: text().notNull(),
    lastError: text(),
    sentAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_source").on(table.organizationId, table.sourceService, table.sourceKey),
    pgPolicy("messages_tenant", { for: "all", using: tenant, withCheck: tenant }),
  ],
).enableRLS();

export { outbox };
export const schema = { messages, outbox };
export type Message = typeof messages.$inferSelect;
