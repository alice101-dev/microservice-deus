import type { ProfileRef } from "@deus/clients";
import { type Database, withTenant } from "@deus/db";
import type { Logger } from "@deus/logger";
import type { OutboxHandler } from "@deus/outbox";
import { eq } from "drizzle-orm";
import { TOPICS } from "./app";
import { type InvoiceData, invoiceEmail, invoicePdf } from "./invoice";
import { messages, type schema } from "./schema";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  attachments: Array<{ filename: string; content: Uint8Array; contentType: string }>;
}

export type Send = (mail: Mail) => Promise<{ messageId: string }>;

export function deliveryHandlers(options: {
  db: Database<typeof schema>;
  logger: Logger;
  profile: (organizationId: string) => Promise<ProfileRef | null>;
  send: Send;
}): Record<string, OutboxHandler> {
  return {
    [TOPICS.send]: async (event) => {
      const { messageId } = event.payload as { messageId: string };
      const organizationId = event.organizationId;
      const [message] = await withTenant(options.db, organizationId, (tx) =>
        tx.select().from(messages).where(eq(messages.id, messageId)),
      );
      if (!message || message.status === "sent") return;
      try {
        const company = await options.profile(organizationId);
        const invoice = message.data as unknown as InvoiceData;
        const { subject, text } = invoiceEmail(invoice, company);
        const pdf = await invoicePdf(invoice, company);
        const sent = await options.send({
          to: message.recipient,
          subject,
          text,
          attachments: [
            {
              filename: `invoice-${invoice.number.replaceAll("/", "-")}.pdf`,
              content: pdf,
              contentType: "application/pdf",
            },
          ],
        });
        await withTenant(options.db, organizationId, (tx) =>
          tx
            .update(messages)
            .set({ status: "sent", subject, sentAt: new Date(), lastError: null })
            .where(eq(messages.id, message.id)),
        );
        options.logger.info("email sent", {
          "notification.message_id": message.id,
          "notification.template": message.template,
          "smtp.message_id": sent.messageId,
        });
      } catch (error) {
        await withTenant(options.db, organizationId, (tx) =>
          tx
            .update(messages)
            .set({ lastError: error instanceof Error ? error.message : String(error) })
            .where(eq(messages.id, message.id)),
        );
        throw error;
      }
    },
  };
}
