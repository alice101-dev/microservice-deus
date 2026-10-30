import { type Attributes, metrics, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { RedisClient } from "bun";

export interface CacheLogger {
  info(message: string, attributes?: Record<string, string | number | boolean>): void;
  warn(message: string, attributes?: Record<string, string | number | boolean>, error?: unknown): void;
}

export interface CacheOptions {
  url?: string;
  prefix: string;
  logger: CacheLogger;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface Cache {
  readonly enabled: boolean;
  ready(): Promise<void>;
  check(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  getAndDelete(key: string): Promise<string | null>;
  increment(key: string, ttlSeconds: number): Promise<number>;
  remember<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T>;
  close(): void;
}

type Command = "GET" | "SET" | "DEL" | "GETDEL" | "EVAL";

const RECONNECT_INTERVAL_MS = 1000;

const DYNAMIC_PARTS = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  /\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi,
  /[A-Za-z0-9_-]{20,}/g,
  /\b\d+\b/g,
];

export function redisKey(key: string): string {
  return DYNAMIC_PARTS.reduce((text, pattern) => text.replace(pattern, "?"), key);
}

const INCREMENT_WITH_TTL =
  "local value = redis.call('INCR', KEYS[1]) if value == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return value";

class CacheTimeoutError extends Error {
  constructor(command: Command, timeoutMs: number) {
    super(`Redis ${command} took longer than ${timeoutMs} ms`);
    this.name = "CacheTimeoutError";
  }
}

const disabled: Cache = {
  enabled: false,
  ready: async () => {},
  check: async () => {},
  get: async () => null,
  set: async () => {},
  del: async () => {},
  getAndDelete: async () => null,
  increment: async () => 1,
  remember: async (_key, _ttl, load) => load(),
  close: () => {},
};

export function createCache(options: CacheOptions): Cache {
  if (!options.url) return disabled;
  const url = new URL(options.url);
  const client = new RedisClient(options.url, {
    connectionTimeout: 2000,
    autoReconnect: true,
    enableOfflineQueue: false,
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  });
  const connected = client.connect().catch(() => {});
  const timeoutMs = options.timeoutMs ?? 250;
  const base: Attributes = {
    "db.system.name": "redis",
    "db.namespace": url.pathname.replace("/", "") || "0",
    "server.address": url.hostname,
    "server.port": Number(url.port || 6379),
  };
  const target = `${base["server.address"]}:${base["server.port"]}`;
  const tracer = trace.getTracer("@deus/cache");
  const meter = metrics.getMeter("@deus/cache");
  const duration = meter.createHistogram("db.client.operation.duration", {
    unit: "s",
    description: "Duration of database client operations",
    advice: { explicitBucketBoundaries: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1] },
  });
  const lookups = meter.createCounter("cache.lookups", {
    unit: "{lookup}",
    description: "Cache reads by result: hit, miss or error",
  });
  let unavailableSince: number | undefined;
  let closed = false;
  let reconnecting = false;
  let lastReconnect = 0;

  const reconnect = () => {
    if (closed || reconnecting || client.connected || Date.now() - lastReconnect < RECONNECT_INTERVAL_MS) return;
    reconnecting = true;
    lastReconnect = Date.now();
    client
      .connect()
      .catch(() => {})
      .finally(() => {
        reconnecting = false;
      });
  };

  const failed = (command: Command, error: unknown) => {
    reconnect();
    if (unavailableSince !== undefined) return;
    unavailableSince = Date.now();
    options.logger.warn("cache unavailable, falling back to the source", { "db.operation.name": command }, error);
  };
  const succeeded = () => {
    if (unavailableSince === undefined) return;
    options.logger.info("cache available again", { "cache.outage_ms": Date.now() - unavailableSince });
    unavailableSince = undefined;
  };

  const run = async <T>(
    command: Command,
    statement: string,
    work: () => Promise<T>,
    describe?: (result: T) => Attributes,
  ): Promise<T> => {
    const attributes: Attributes = { ...base, "db.operation.name": command };
    const measured = async (span?: Span) => {
      const started = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CacheTimeoutError(command, timeoutMs)), timeoutMs);
        });
        const result = await Promise.race([work(), timeout]);
        if (describe) span?.setAttributes(describe(result));
        return result;
      } catch (error) {
        attributes["error.type"] = (error as Error).name;
        span?.setAttribute("error.type", String(attributes["error.type"]));
        span?.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        throw error;
      } finally {
        clearTimeout(timer);
        duration.record((performance.now() - started) / 1000, attributes);
        span?.end();
      }
    };
    if (!trace.getActiveSpan()) return measured();
    return tracer.startActiveSpan(
      `${command} ${target}`,
      { kind: SpanKind.CLIENT, attributes: { ...attributes, "db.query.text": statement } },
      measured,
    );
  };

  const key = (name: string) => `${options.prefix}:${name}`;
  const shown = (name: string) => redisKey(key(name));
  const ttl = (seconds: number) => Math.max(1, Math.ceil(seconds));

  const cache: Cache = {
    enabled: true,
    ready: () => connected,
    async check() {
      if (client.connected) return;
      reconnect();
      throw new Error("Redis is not connected");
    },
    async get(name) {
      try {
        const value = await run(
          "GET",
          `GET ${shown(name)}`,
          () => client.get(key(name)),
          (result) => ({ "db.response.returned_rows": result === null ? 0 : 1 }),
        );
        succeeded();
        lookups.add(1, { "cache.result": value === null ? "miss" : "hit" });
        return value;
      } catch (error) {
        failed("GET", error);
        lookups.add(1, { "cache.result": "error" });
        return null;
      }
    },
    async set(name, value, ttlSeconds) {
      try {
        await run("SET", `SET ${shown(name)} ?${ttlSeconds ? ` EX ${ttl(ttlSeconds)}` : ""}`, () =>
          ttlSeconds ? client.set(key(name), value, "EX", ttl(ttlSeconds)) : client.set(key(name), value),
        );
        succeeded();
      } catch (error) {
        failed("SET", error);
      }
    },
    async del(name) {
      try {
        await run("DEL", `DEL ${shown(name)}`, () => client.del(key(name)));
        succeeded();
      } catch (error) {
        failed("DEL", error);
      }
    },
    async getAndDelete(name) {
      try {
        const value = await run(
          "GETDEL",
          `GETDEL ${shown(name)}`,
          () => client.send("GETDEL", [key(name)]) as Promise<string | null>,
          (result) => ({ "db.response.returned_rows": result === null ? 0 : 1 }),
        );
        succeeded();
        return value;
      } catch (error) {
        failed("GETDEL", error);
        return null;
      }
    },
    async increment(name, ttlSeconds) {
      try {
        const value = await run("EVAL", `EVAL "${INCREMENT_WITH_TTL}" 1 ${shown(name)} ${ttl(ttlSeconds)}`, () =>
          client.send("EVAL", [INCREMENT_WITH_TTL, "1", key(name), String(ttl(ttlSeconds))]),
        );
        succeeded();
        return Number(value);
      } catch (error) {
        failed("EVAL", error);
        return 1;
      }
    },
    async remember(name, ttlSeconds, load) {
      const cached = await cache.get(name);
      if (cached !== null) return JSON.parse(cached);
      const value = await load();
      await cache.set(name, JSON.stringify(value), ttlSeconds);
      return value;
    },
    close: () => {
      closed = true;
      client.close();
    },
  };
  return cache;
}
