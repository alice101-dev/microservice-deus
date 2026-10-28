import type { Database, Transaction } from "@deus/db";
import { AppError } from "@deus/errors";
import type { Logger } from "@deus/logger";
import { context, metrics, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const outbox = pgTable(
  "outbox",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    topic: text().notNull(),
    payload: jsonb().notNull(),
    traceparent: text(),
    attempts: integer().notNull().default(0),
    availableAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp({ withTimezone: true }),
    deliveredAt: timestamp({ withTimezone: true }),
    deadAt: timestamp({ withTimezone: true }),
    lastError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("outbox_due").on(table.availableAt).where(sql`delivered_at is null and dead_at is null`),
    index("outbox_delivered").on(table.deliveredAt).where(sql`delivered_at is not null`),
  ],
);

export interface OutboxEvent<P = unknown> {
  id: string;
  organizationId: string;
  topic: string;
  payload: P;
  attempts: number;
  createdAt: Date;
}

type AnyTransaction = Transaction<Record<string, unknown>>;
type AnyDatabase = Database<Record<string, unknown>>;

export async function enqueue<P>(
  tx: AnyTransaction | Transaction<never>,
  event: { organizationId: string; topic: string; payload: P },
) {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const [row] = await (tx as AnyTransaction)
    .insert(outbox)
    .values({
      organizationId: event.organizationId,
      topic: event.topic,
      payload: event.payload,
      traceparent: carrier.traceparent ?? null,
    })
    .returning({ id: outbox.id });
  return (row as { id: string }).id;
}

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

export interface RelayOptions {
  db: AnyDatabase | Database<never>;
  handlers: Record<string, OutboxHandler>;
  logger: Logger;
  batchSize?: number;
  intervalMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  retentionMs?: number;
  permanentStatuses?: readonly number[];
}

interface ClaimedRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  topic: string;
  payload: unknown;
  traceparent: string | null;
  attempts: number;
  created_at: string | Date;
}

const DELAY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900, 3600];

export function backoffMs(attempts: number) {
  const base = Math.min(1000 * 2 ** Math.max(attempts - 1, 0), 5 * 60 * 1000);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export function createRelay(options: RelayOptions) {
  const db = options.db as AnyDatabase;
  const batchSize = options.batchSize ?? 20;
  const intervalMs = options.intervalMs ?? 1000;
  const leaseMs = options.leaseMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 12;
  const retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
  const permanent = new Set(options.permanentStatuses ?? [400, 404, 422]);
  const tracer = trace.getTracer("@deus/outbox");
  const meter = metrics.getMeter("@deus/outbox");
  const outcomes = meter.createCounter("outbox.events", { description: "Outbox deliveries by topic and outcome" });
  const delay = meter.createHistogram("outbox.delivery.delay", {
    unit: "s",
    description: "Time from enqueue to successful delivery",
    advice: { explicitBucketBoundaries: DELAY_BUCKETS },
  });
  const backlog = { pending: 0, dead: 0 };
  meter
    .createObservableGauge("outbox.backlog", { description: "Outbox events not delivered, by state" })
    .addCallback((result) => {
      result.observe(backlog.pending, { "outbox.state": "pending" });
      result.observe(backlog.dead, { "outbox.state": "dead" });
    });

  const claim = async () => {
    const result = await db.execute<ClaimedRow>(sql`
      update outbox set lease_until = now() + ${`${leaseMs} milliseconds`}::interval, attempts = attempts + 1
      where id in (
        select id from outbox
        where delivered_at is null and dead_at is null and available_at <= now()
          and (lease_until is null or lease_until < now())
        order by available_at
        limit ${batchSize}
        for update skip locked
      )
      returning id, organization_id, topic, payload, traceparent, attempts, created_at`);
    return result.rows;
  };

  const settle = async (row: ClaimedRow, error: unknown) => {
    const status = error instanceof AppError ? error.status : undefined;
    const message = error instanceof Error ? error.message : String(error);
    const attributes = {
      "messaging.destination.name": row.topic,
      "messaging.message.id": row.id,
      "outbox.attempts": row.attempts,
      "http.response.status_code": status,
    };
    const dead = row.attempts >= maxAttempts || (status !== undefined && permanent.has(status));
    if (dead) {
      await db.execute(
        sql`update outbox set dead_at = now(), lease_until = null, last_error = ${message} where id = ${row.id}`,
      );
      outcomes.add(1, { "messaging.destination.name": row.topic, "outbox.outcome": "dead" });
      options.logger.error("outbox event dead", attributes, error);
      return;
    }
    const retryIn = backoffMs(row.attempts);
    await db.execute(sql`
      update outbox set lease_until = null, last_error = ${message},
        available_at = now() + ${`${retryIn} milliseconds`}::interval
      where id = ${row.id}`);
    outcomes.add(1, { "messaging.destination.name": row.topic, "outbox.outcome": "retry" });
    options.logger.warn("outbox delivery failed, will retry", { ...attributes, "outbox.retry_in_ms": retryIn }, error);
  };

  const deliver = async (row: ClaimedRow) => {
    const parent = row.traceparent
      ? propagation.extract(context.active(), { traceparent: row.traceparent })
      : context.active();
    await tracer.startActiveSpan(
      `deliver ${row.topic}`,
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          "messaging.system": "outbox",
          "messaging.operation.type": "send",
          "messaging.destination.name": row.topic,
          "messaging.message.id": row.id,
          "outbox.attempts": row.attempts,
        },
      },
      parent,
      async (span) => {
        try {
          const handler = options.handlers[row.topic];
          if (!handler) throw new AppError(422, "unknown_topic", `No handler for topic ${row.topic}`);
          const createdAt = new Date(row.created_at);
          await handler({
            id: row.id,
            organizationId: row.organization_id,
            topic: row.topic,
            payload: row.payload,
            attempts: row.attempts,
            createdAt,
          });
          await db.execute(
            sql`update outbox set delivered_at = now(), lease_until = null, last_error = null where id = ${row.id}`,
          );
          outcomes.add(1, { "messaging.destination.name": row.topic, "outbox.outcome": "delivered" });
          delay.record((Date.now() - createdAt.getTime()) / 1000, { "messaging.destination.name": row.topic });
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
          await settle(row, error);
        } finally {
          span.end();
        }
      },
    );
  };

  const runOnce = async () => {
    const rows = await claim();
    for (const row of rows) await deliver(row);
    return rows.length;
  };

  const measure = async () => {
    const result = await db.execute<{ pending: string; dead: string }>(sql`
      select count(*) filter (where delivered_at is null and dead_at is null) as pending,
             count(*) filter (where dead_at is not null) as dead
      from outbox`);
    backlog.pending = Number(result.rows[0]?.pending ?? 0);
    backlog.dead = Number(result.rows[0]?.dead ?? 0);
  };

  const purge = async () => {
    const result = await db.execute(
      sql`delete from outbox where delivered_at < now() - ${`${retentionMs} milliseconds`}::interval`,
    );
    return result.rowCount ?? 0;
  };

  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let lastMaintenance = 0;

  const tick = async () => {
    try {
      const claimed = await runOnce();
      if (Date.now() - lastMaintenance > 60_000) {
        lastMaintenance = Date.now();
        await measure();
        const purged = await purge();
        if (purged > 0) options.logger.info("outbox purged", { "outbox.purged": purged });
      }
      if (!stopped) timer = setTimeout(loop, claimed === batchSize ? 0 : intervalMs);
    } catch (error) {
      options.logger.error("outbox relay failed", {}, error);
      if (!stopped) timer = setTimeout(loop, intervalMs * 5);
    }
  };
  const loop = () => {
    running = tick();
  };

  return {
    runOnce,
    measure,
    purge,
    backlog: () => ({ ...backlog }),
    start() {
      if (!stopped) return;
      stopped = false;
      loop();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}

export type Relay = ReturnType<typeof createRelay>;
