import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { SpanKind, trace } from "@opentelemetry/api";
import { createCache } from "../src";

const url = process.env.REDIS_TEST_URL;
const { telemetry, spans } = startTestTelemetry("cache-test");
afterAll(() => telemetry.shutdown());

const quiet = { info: () => {}, warn: () => {} };

test("without a URL the cache is off and every read goes to the source", async () => {
  const cache = createCache({ prefix: "test", logger: quiet });
  let loads = 0;
  expect(cache.enabled).toBe(false);
  expect(await cache.get("anything")).toBeNull();
  expect(await cache.remember("chart", 60, async () => ++loads)).toBe(1);
  expect(await cache.remember("chart", 60, async () => ++loads)).toBe(2);
});

test("an unreachable Redis is a miss, warned about once", async () => {
  const warnings: string[] = [];
  const cache = createCache({
    url: "redis://127.0.0.1:1/0",
    prefix: "test",
    timeoutMs: 100,
    logger: { info: () => {}, warn: (message) => warnings.push(message) },
  });
  const started = performance.now();
  expect(await cache.get("a")).toBeNull();
  await cache.set("a", "1", 60);
  expect(await cache.remember("b", 60, async () => "from source")).toBe("from source");
  expect(await cache.increment("c", 60)).toBe(1);
  expect(await cache.getAndDelete("d")).toBeNull();
  expect(performance.now() - started).toBeLessThan(3000);
  expect(warnings).toEqual(["cache unavailable, falling back to the source"]);
  cache.close();
});

describe.skipIf(!url)("against Redis", () => {
  const cache = createCache({ url, prefix: `test-${process.pid}`, logger: quiet });
  beforeAll(() => cache.ready());
  afterAll(() => cache.close());

  test("stores, expires and deletes values under the service prefix", async () => {
    await cache.set("session", "token-data", 1);
    expect(await cache.get("session")).toBe("token-data");
    await cache.del("session");
    expect(await cache.get("session")).toBeNull();
    await cache.set("short", "x", 1);
    await Bun.sleep(1100);
    expect(await cache.get("short")).toBeNull();
  });

  test("gets and deletes in one step, and counts with a TTL set on creation only", async () => {
    await cache.set("verification", "code-123", 60);
    expect(await cache.getAndDelete("verification")).toBe("code-123");
    expect(await cache.getAndDelete("verification")).toBeNull();
    expect(await cache.increment("attempts", 1)).toBe(1);
    expect(await cache.increment("attempts", 60)).toBe(2);
    await Bun.sleep(1100);
    expect(await cache.increment("attempts", 1)).toBe(1);
  });

  test("remember loads once and serves the cached value after", async () => {
    let loads = 0;
    const load = async () => ({ accounts: ++loads });
    expect(await cache.remember("chart", 60, load)).toEqual({ accounts: 1 });
    expect(await cache.remember("chart", 60, load)).toEqual({ accounts: 1 });
    expect(loads).toBe(1);
  });

  test("traces commands only under a parent span, without the key", async () => {
    spans.reset();
    await cache.get("background");
    await trace.getTracer("cache-test").startActiveSpan("request", async (request) => {
      await cache.set("secret-session-token", "v", 60);
      await cache.get("secret-session-token");
      await cache.get("missing");
      request.end();
    });
    const commands = spans.getFinishedSpans().filter((span) => span.kind === SpanKind.CLIENT);
    expect(commands.map((span) => span.name)).toEqual(["SET", "GET", "GET"]);
    expect(commands.every((span) => span.attributes["db.system.name"] === "redis")).toBe(true);
    expect(commands.map((span) => span.attributes["db.response.returned_rows"])).toEqual([undefined, 1, 0]);
    expect(JSON.stringify(commands.map((span) => span.attributes))).not.toContain("secret-session-token");
  });
});
