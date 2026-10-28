import type { Ledger } from "@deus/clients";
import { AppError } from "@deus/errors";
import type { OutboxHandler } from "@deus/outbox";
import { TOPICS } from "./app";

export function purchaseHandlers(ledger: Ledger): Record<string, OutboxHandler> {
  return {
    [TOPICS.journal]: async (event) => {
      await ledger.post(event.payload as Parameters<Ledger["post"]>[0], event.id);
    },
    [TOPICS.reversal]: async (event) => {
      try {
        await ledger.reverse(event.payload as Parameters<Ledger["reverse"]>[0]);
      } catch (error) {
        if (error instanceof AppError && error.status === 404) {
          throw new Error("the bill journal is not posted yet", { cause: error });
        }
        throw error;
      }
    },
  };
}
