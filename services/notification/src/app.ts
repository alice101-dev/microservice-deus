import {
  authentication,
  requireOrganization,
  type ServiceVerifier,
  serviceAuthentication,
  type Verifier,
} from "@deus/auth";
import type { BaseConfig } from "@deus/config";
import { type Database, withTenant } from "@deus/db";
import { BadRequestError, NotFoundError } from "@deus/errors";
import { createService } from "@deus/http";
import type { Logger } from "@deus/logger";
import { enqueue } from "@deus/outbox";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";
import { type Message, messages, type schema } from "./schema";

export const TOPICS = { send: "email.send" } as const;
export const SENDERS = ["sales", "purchases", "reporting"] as const;

export interface NotificationContext {
  config: BaseConfig;
  logger: Logger;
  db: Database<typeof schema>;
  verify: Verifier;
  verifyService: ServiceVerifier;
  readiness?: Array<() => Promise<void>>;
}

const MessageView = t.Object({
  id: t.String(),
  template: t.String(),
  recipient: t.String(),
  subject: t.Nullable(t.String()),
  status: t.Union([t.Literal("queued"), t.Literal("sent")]),
  sourceService: t.String(),
  lastError: t.Nullable(t.String()),
  sentAt: t.Nullable(t.String()),
  createdAt: t.String(),
});
const view = (message: Message) => ({
  id: message.id,
  template: message.template,
  recipient: message.recipient,
  subject: message.subject,
  status: message.status,
  sourceService: message.sourceService,
  lastError: message.lastError,
  sentAt: message.sentAt ? message.sentAt.toISOString() : null,
  createdAt: message.createdAt.toISOString(),
});

export function createApp(context: NotificationContext) {
  const { db } = context;
  return createService({ config: context.config, logger: context.logger, readiness: context.readiness })
    .group("/api/notification", (api) =>
      api
        .use(authentication(context.verify))
        .get(
          "/messages",
          async ({ principal, query }) => {
            const rows = await withTenant(db, requireOrganization(principal), (tx) =>
              tx
                .select()
                .from(messages)
                .where(and(query.status ? eq(messages.status, query.status) : undefined))
                .orderBy(desc(messages.createdAt))
                .limit(200),
            );
            return rows.map(view);
          },
          {
            query: t.Object({ status: t.Optional(t.Union([t.Literal("queued"), t.Literal("sent")])) }),
            response: t.Array(MessageView),
            detail: { summary: "Emails sent or queued for the active organization, newest first" },
          },
        )
        .get(
          "/messages/:id",
          async ({ principal, params }) => {
            const [row] = await withTenant(db, requireOrganization(principal), (tx) =>
              tx.select().from(messages).where(eq(messages.id, params.id)),
            );
            if (!row) throw new NotFoundError("The message does not exist");
            return view(row);
          },
          {
            params: t.Object({ id: t.String({ format: "uuid" }) }),
            response: MessageView,
            detail: { summary: "One email" },
          },
        ),
    )
    .group("/internal/notification", (internal) =>
      internal.use(serviceAuthentication(context.verifyService, SENDERS)).post(
        "/messages",
        async ({ caller, body, headers, set }) => {
          const key = headers["idempotency-key"];
          if (!key) throw new BadRequestError("Idempotency-Key is required");
          const result = await withTenant(db, body.organizationId, async (tx) => {
            const [created] = await tx
              .insert(messages)
              .values({
                organizationId: body.organizationId,
                template: body.template,
                recipient: body.to,
                data: body.data,
                sourceService: caller.service,
                sourceKey: key,
              })
              .onConflictDoNothing({ target: [messages.organizationId, messages.sourceService, messages.sourceKey] })
              .returning();
            if (created) {
              await enqueue(tx, {
                organizationId: body.organizationId,
                topic: TOPICS.send,
                payload: { messageId: created.id },
              });
              return { message: created, created: true };
            }
            const [existing] = await tx
              .select()
              .from(messages)
              .where(and(eq(messages.sourceService, caller.service), eq(messages.sourceKey, key)));
            return { message: existing as Message, created: false };
          });
          if (result.created) set.status = 202;
          return view(result.message);
        },
        {
          body: t.Object({
            organizationId: t.String({ format: "uuid" }),
            template: t.Literal("invoice.issued"),
            to: t.String({ format: "email", maxLength: 200 }),
            data: t.Record(t.String(), t.Unknown()),
          }),
          response: { 200: MessageView, 202: MessageView },
          detail: { summary: "Queue an email for another service, once per Idempotency-Key" },
        },
      ),
    );
}
