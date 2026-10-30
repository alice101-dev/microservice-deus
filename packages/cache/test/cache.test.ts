import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { SpanKind, trace } from "@opentelemetry/api";
import { createCache, redisKey } from "../src";

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

test("Redis keys keep their structure while tokens, identifiers and addresses are masked", () => {
  expect(redisKey("accounts:chart:49855adb-1da4-4abd-b1a4-ad3780c72ea8")).toBe("accounts:chart:?");
  expect(redisKey(`identity:${"s".repeat(32)}`)).toBe("identity:?");
  expect(redisKey("identity:active-sessions-6e57b1bb-d0fa-4306-810d-86914dca75b4")).toBe("identity:active-sessions-?");
  expect(redisKey("identity:10.124.2.81/sign-in/email")).toBe("identity:?/sign-in/email");
  expect(redisKey("identity:2001:db8::7334/sign-in/email")).toBe("identity:?/sign-in/email");
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
  await expect(cache.check()).rejects.toThrow("Redis is not connected");
  cache.close();
});

describe.skipIf(!url)("against Redis", () => {
  test("is not ready while Redis is unreachable and reconnects after the client gave up", async () => {
    const target = new URL(url as string);
    const port = 40000 + (process.pid % 20000);
    const refusing = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { open: (socket) => void socket.end(), data() {} },
    });
    const logs: string[] = [];
    const cache = createCache({
      url: `redis://${target.username}:${target.password}@127.0.0.1:${port}/0`,
      prefix: `test-${process.pid}`,
      timeoutMs: 100,
      maxRetries: 1,
      logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
    });
    await cache.ready();
    expect(await cache.get("late")).toBeNull();
    await expect(cache.check()).rejects.toThrow("Redis is not connected");
    refusing.stop(true);

    const upstreams = new Map<object, Awaited<ReturnType<typeof Bun.connect>>>();
    const proxy = Bun.listen<{ pending: Uint8Array[] }>({
      hostname: "127.0.0.1",
      port,
      socket: {
        async open(socket) {
          socket.data = { pending: [] };
          const upstream = await Bun.connect({
            hostname: target.hostname,
            port: Number(target.port),
            socket: { data: (_, chunk) => void socket.write(chunk), close: () => void socket.end() },
          });
          upstreams.set(socket, upstream);
          for (const chunk of socket.data.pending) upstream.write(chunk);
        },
        data(socket, chunk) {
          const upstream = upstreams.get(socket);
          if (upstream) upstream.write(chunk);
          else socket.data.pending.push(new Uint8Array(chunk));
        },
        close: (socket) => void upstreams.get(socket)?.end(),
      },
    });
    try {
      let value: string | null = null;
      for (let attempt = 0; attempt < 15 && value === null; attempt++) {
        await Bun.sleep(200);
        await cache.check().catch(() => {});
        await cache.set("late", "back", 60);
        value = await cache.get("late");
      }
      expect(value).toBe("back");
      await cache.check();
      expect(logs).toEqual(["cache unavailable, falling back to the source", "cache available again"]);
    } finally {
      cache.close();
      proxy.stop(true);
    }
  });

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

  test("traces commands only under a parent span, with the key masked and never the value", async () => {
    const token = "s".repeat(32);
    spans.reset();
    await cache.get("background");
    await trace.getTracer("cache-test").startActiveSpan("request", async (request) => {
      await cache.set(token, "stored-session-payload", 60);
      await cache.get(token);
      await cache.get("missing");
      request.end();
    });
    const commands = spans.getFinishedSpans().filter((span) => span.kind === SpanKind.CLIENT);
    const server = `${new URL(url as string).hostname}:${new URL(url as string).port}`;
    expect(commands.map((span) => span.name)).toEqual([`SET ${server}`, `GET ${server}`, `GET ${server}`]);
    expect(commands.every((span) => span.attributes["db.system.name"] === "redis")).toBe(true);
    expect(commands.map((span) => span.attributes["db.response.returned_rows"])).toEqual([undefined, 1, 0]);
    expect(commands.map((span) => span.attributes["db.query.text"])).toEqual([
      "SET test-?:? ? EX 60",
      "GET test-?:?",
      "GET test-?:missing",
    ]);
    const recorded = JSON.stringify(commands.map((span) => span.attributes));
    expect(recorded).not.toContain(token);
    expect(recorded).not.toContain("stored-session-payload");
  });
});
