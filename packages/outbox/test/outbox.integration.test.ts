import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestDatabase } from "@deus/db/testing";
import { UnprocessableError } from "@deus/errors";
import { createLogger } from "@deus/logger";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { SpanKind, trace } from "@opentelemetry/api";
import { sql } from "drizzle-orm";
import { createRelay, enqueue, type OutboxEvent, outbox } from "../src";

const url = process.env.DATABASE_TEST_URL;
const { telemetry, spans } = startTestTelemetry("outbox-test");
afterAll(() => telemetry.shutdown());

const ORG = "00000000-0000-4000-8000-00000000000a";
const schema = { outbox };

describe.skipIf(!url)("outbox against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase<typeof schema>>>;
  const logger = createLogger({ name: "outbox-test" });

  beforeAll(async () => {
    database = await createTestDatabase({
      url: url ?? "",
      service: "outbox",
      serviceDirectory: join(import.meta.dir, "fixture"),
      schema,
    });
  });
  afterAll(() => database.cleanup());
  beforeEach(async () => {
    await database.db.execute(sql`delete from outbox`);
    spans.reset();
  });

  const rows = async () =>
    (await database.db.select().from(outbox)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  test("writes the event with the business transaction and drops it on rollback", async () => {
    await database.db.transaction((tx) =>
      enqueue(tx, { organizationId: ORG, topic: "invoice.issued", payload: { n: 1 } }),
    );
    expect(
      database.db.transaction(async (tx) => {
        await enqueue(tx, { organizationId: ORG, topic: "invoice.issued", payload: { n: 2 } });
        throw new Error("business rule failed");
      }),
    ).rejects.toThrow("business rule failed");
    expect((await rows()).map((row) => row.payload)).toEqual([{ n: 1 }]);
  });

  test("delivers once, continuing the trace of the request that enqueued it", async () => {
    const tracer = trace.getTracer("test");
    const traceId = await tracer.startActiveSpan("POST /api/sales/invoices", async (span) => {
      await database.db.transaction((tx) =>
        enqueue(tx, { organizationId: ORG, topic: "invoice.issued", payload: { invoice: "inv-1" } }),
      );
      span.end();
      return span.spanContext().traceId;
    });
    const delivered: OutboxEvent[] = [];
    const relay = createRelay({
      db: database.db,
      logger,
      handlers: { "invoice.issued": async (event) => void delivered.push(event) },
    });
    expect(await relay.runOnce()).toBe(1);
    expect(await relay.runOnce()).toBe(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      organizationId: ORG,
      topic: "invoice.issued",
      payload: { invoice: "inv-1" },
      attempts: 1,
    });
    const [row] = await rows();
    expect(row?.deliveredAt).toBeInstanceOf(Date);
    const span = spans.getFinishedSpans().find((entry) => entry.name === "deliver invoice.issued");
    expect(span?.kind).toBe(SpanKind.PRODUCER);
    expect(span?.spanContext().traceId).toBe(traceId);
  });

  test("retries with backoff and gives up after the last attempt", async () => {
    await database.db.transaction((tx) => enqueue(tx, { organizationId: ORG, topic: "invoice.issued", payload: {} }));
    let calls = 0;
    const relay = createRelay({
      db: database.db,
      logger,
      maxAttempts: 2,
      handlers: {
        "invoice.issued": async () => {
          calls++;
          throw new Error("ledger unreachable");
        },
      },
    });
    expect(await relay.runOnce()).toBe(1);
    let [row] = await rows();
    expect(row).toMatchObject({ attempts: 1, deadAt: null, lastError: "ledger unreachable" });
    expect((row?.availableAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(500);
    expect(await relay.runOnce()).toBe(0);

    await database.db.execute(sql`update outbox set available_at = now()`);
    expect(await relay.runOnce()).toBe(1);
    [row] = await rows();
    expect(row?.deadAt).toBeInstanceOf(Date);
    expect(calls).toBe(2);
    await relay.measure();
    expect(relay.backlog()).toEqual({ pending: 0, dead: 1 });
  });

  test("marks an event dead at once when the receiver rejects it as invalid", async () => {
    await database.db.transaction((tx) => enqueue(tx, { organizationId: ORG, topic: "invoice.issued", payload: {} }));
    await database.db.transaction((tx) => enqueue(tx, { organizationId: ORG, topic: "unknown.topic", payload: {} }));
    const relay = createRelay({
      db: database.db,
      logger,
      handlers: {
        "invoice.issued": async () => {
          throw new UnprocessableError("The period 2026-01 is closed");
        },
      },
    });
    expect(await relay.runOnce()).toBe(2);
    expect((await rows()).map((row) => [row.attempts, row.deadAt !== null])).toEqual([
      [1, true],
      [1, true],
    ]);
  });

  test("lets competing relays deliver every event exactly once", async () => {
    for (let n = 0; n < 30; n++) {
      await database.db.transaction((tx) =>
        enqueue(tx, { organizationId: ORG, topic: "invoice.issued", payload: { n } }),
      );
    }
    const seen: number[] = [];
    const handlers = {
      "invoice.issued": async (event: OutboxEvent) => {
        await Bun.sleep(2);
        seen.push((event.payload as { n: number }).n);
      },
    };
    const relays = [1, 2, 3].map(() => createRelay({ db: database.db, logger, batchSize: 4, handlers }));
    for (;;) {
      const claimed = await Promise.all(relays.map((relay) => relay.runOnce()));
      if (claimed.every((count) => count === 0)) break;
    }
    expect(seen.sort((a, b) => a - b)).toEqual([...Array(30).keys()]);
  });

  test("reclaims an event whose lease expired without an outcome", async () => {
    await database.db.transaction((tx) => enqueue(tx, { organizationId: ORG, topic: "invoice.issued", payload: {} }));
    await database.db.execute(sql`update outbox set lease_until = now() + interval '1 minute', attempts = 1`);
    const delivered: string[] = [];
    const relay = createRelay({
      db: database.db,
      logger,
      handlers: { "invoice.issued": async (event) => void delivered.push(event.id) },
    });
    expect(await relay.runOnce()).toBe(0);
    await database.db.execute(sql`update outbox set lease_until = now() - interval '1 second'`);
    expect(await relay.runOnce()).toBe(1);
    expect((await rows())[0]?.attempts).toBe(2);
  });

  test("runs in the background until stopped and purges old deliveries", async () => {
    const relay = createRelay({
      db: database.db,
      logger,
      intervalMs: 20,
      retentionMs: 1000,
      handlers: { "invoice.issued": async () => {} },
    });
    relay.start();
    await database.db.transaction((tx) => enqueue(tx, { organizationId: ORG, topic: "invoice.issued", payload: {} }));
    for (let i = 0; i < 50 && !(await rows())[0]?.deliveredAt; i++) await Bun.sleep(20);
    await relay.stop();
    expect((await rows())[0]?.deliveredAt).toBeInstanceOf(Date);
    await database.db.execute(sql`update outbox set delivered_at = now() - interval '1 hour'`);
    expect(await relay.purge()).toBe(1);
  });
});
