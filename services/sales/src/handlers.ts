import type { EmailRequest, Ledger, Notification } from "@deus/clients";
import { AppError } from "@deus/errors";
import type { OutboxHandler } from "@deus/outbox";
import { TOPICS } from "./app";

export function salesHandlers(ledger: Ledger, notification?: Notification): Record<string, OutboxHandler> {
  return {
    [TOPICS.email]: async (event) => {
      if (!notification) throw new Error("notification is not configured");
      await notification.queue(event.payload as EmailRequest, event.id);
    },
    [TOPICS.journal]: async (event) => {
      await ledger.post(event.payload as Parameters<Ledger["post"]>[0], event.id);
    },
    [TOPICS.reversal]: async (event) => {
      try {
        await ledger.reverse(event.payload as Parameters<Ledger["reverse"]>[0]);
      } catch (error) {
        if (error instanceof AppError && error.status === 404) {
          throw new Error("the invoice journal is not posted yet", { cause: error });
        }
        throw error;
      }
    },
  };
}
