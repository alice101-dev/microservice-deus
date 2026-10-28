import type { Allocations, Ledger } from "@deus/clients";
import type { Database } from "@deus/db";
import { AppError } from "@deus/errors";
import type { OutboxHandler } from "@deus/outbox";
import { sql } from "drizzle-orm";
import { TOPICS } from "./app";
import type { schema } from "./schema";

export function paymentHandlers(options: {
  db: Database<typeof schema>;
  ledger: Ledger;
  sales: Allocations;
  purchases: Allocations;
}): Record<string, OutboxHandler> {
  const { db, ledger } = options;
  const applied = async (topic: string, paymentId: string) => {
    const result = await db.execute<{ pending: string }>(sql`
      select count(*) as pending from outbox
      where topic = ${topic} and payload->>'paymentId' = ${paymentId} and delivered_at is null and dead_at is null`);
    if (Number(result.rows[0]?.pending ?? 0) > 0) throw new Error("the allocations are not applied yet");
  };
  const reverse =
    (target: Allocations, applyTopic: string): OutboxHandler =>
    async (event) => {
      const payload = event.payload as { organizationId: string; paymentId: string };
      await applied(applyTopic, payload.paymentId);
      await target.reverse(payload);
    };
  return {
    [TOPICS.journal]: async (event) => {
      await ledger.post(event.payload as Parameters<Ledger["post"]>[0], event.id);
    },
    [TOPICS.reversal]: async (event) => {
      try {
        await ledger.reverse(event.payload as Parameters<Ledger["reverse"]>[0]);
      } catch (error) {
        if (error instanceof AppError && error.status === 404) {
          throw new Error("the payment journal is not posted yet", { cause: error });
        }
        throw error;
      }
    },
    [TOPICS.salesAllocations]: async (event) => {
      await options.sales.apply(event.payload as Parameters<Allocations["apply"]>[0]);
    },
    [TOPICS.purchasesAllocations]: async (event) => {
      await options.purchases.apply(event.payload as Parameters<Allocations["apply"]>[0]);
    },
    [TOPICS.salesAllocationsReverse]: reverse(options.sales, TOPICS.salesAllocations),
    [TOPICS.purchasesAllocationsReverse]: reverse(options.purchases, TOPICS.purchasesAllocations),
  };
}
