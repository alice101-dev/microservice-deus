import { type Attributes, metrics, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

export interface DatabaseOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  applicationName: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
}

const UNTRACED = Symbol("deus.db.untraced");

export function operationName(text: string): string {
  const match = text.trimStart().match(/^(with\b[\s\S]*?\)\s*)?([a-z]+)/i);
  return (match?.[2] ?? "query").toUpperCase();
}

function queryText(args: unknown[]): string {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "text" in first) return String((first as { text: unknown }).text);
  return "";
}

interface Instruments {
  tracer: ReturnType<typeof trace.getTracer>;
  duration: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]>;
}

type Query = (...args: unknown[]) => unknown;
type Queryable = { query: Query; [UNTRACED]?: Query };

function instrumentQueries(target: pg.Pool | pg.PoolClient, base: Attributes, { tracer, duration }: Instruments) {
  const tagged = target as unknown as Queryable;
  if (tagged[UNTRACED]) return;
  const original = tagged.query.bind(target);
  tagged[UNTRACED] = original;
  tagged.query = (...args: unknown[]) => {
    if (typeof args[args.length - 1] === "function") return original(...args);
    const text = queryText(args);
    const operation = operationName(text);
    const attributes: Attributes = { ...base, "db.operation.name": operation };
    const measured = async (span?: Span) => {
      const started = performance.now();
      try {
        const result = (await original(...args)) as pg.QueryResult;
        if (typeof result?.rowCount === "number") span?.setAttribute("db.response.returned_rows", result.rowCount);
        return result;
      } catch (error) {
        const code = (error as { code?: string }).code;
        attributes["error.type"] = code ?? (error as Error).name;
        if (span) {
          if (code) span.setAttribute("db.response.status_code", code);
          span.setAttribute("error.type", String(attributes["error.type"]));
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        }
        throw error;
      } finally {
        duration.record((performance.now() - started) / 1000, attributes);
        span?.end();
      }
    };
    if (!trace.getActiveSpan()) return measured();
    return tracer.startActiveSpan(
      `${operation} ${base["db.namespace"]}`,
      { kind: SpanKind.CLIENT, attributes: { ...attributes, "db.query.text": text } },
      measured,
    );
  };
}

export function createPool(options: DatabaseOptions): pg.Pool {
  const pool = new pg.Pool({
    host: options.host,
    port: options.port,
    database: options.database,
    user: options.user,
    password: options.password,
    application_name: options.applicationName,
    max: options.maxConnections ?? 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    options: [
      `-c statement_timeout=${options.statementTimeoutMs ?? 5000}`,
      `-c lock_timeout=${options.lockTimeoutMs ?? 2000}`,
      `-c idle_in_transaction_session_timeout=${options.idleInTransactionTimeoutMs ?? 30000}`,
    ].join(" "),
  });
  const base: Attributes = {
    "db.system.name": "postgresql",
    "db.namespace": options.database,
    "server.address": options.host,
    "server.port": options.port,
  };
  const meter = metrics.getMeter("@deus/db");
  const instruments: Instruments = {
    tracer: trace.getTracer("@deus/db"),
    duration: meter.createHistogram("db.client.operation.duration", {
      unit: "s",
      description: "Duration of database client operations",
      advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
    }),
  };
  instrumentQueries(pool, base, instruments);
  pool.on("connect", (client) => instrumentQueries(client, base, instruments));
  const poolName = `${options.host}/${options.database}`;
  meter
    .createObservableUpDownCounter("db.client.connection.count", {
      unit: "{connection}",
      description: "Connections of the pool by state",
    })
    .addCallback((result) => {
      result.observe(pool.idleCount, {
        "db.client.connection.pool.name": poolName,
        "db.client.connection.state": "idle",
      });
      result.observe(pool.totalCount - pool.idleCount, {
        "db.client.connection.pool.name": poolName,
        "db.client.connection.state": "used",
      });
    });
  meter
    .createObservableUpDownCounter("db.client.connection.pending_requests", {
      unit: "{request}",
      description: "Requests waiting for a connection",
    })
    .addCallback((result) => result.observe(pool.waitingCount, { "db.client.connection.pool.name": poolName }));
  return pool;
}

export function createDatabase<TSchema extends Record<string, unknown>>(pool: pg.Pool, schema: TSchema) {
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export type Database<TSchema extends Record<string, unknown>> = NodePgDatabase<TSchema>;
export type Transaction<TSchema extends Record<string, unknown>> = Parameters<
  Parameters<Database<TSchema>["transaction"]>[0]
>[0];

export function withTenant<TSchema extends Record<string, unknown>, T>(
  db: Database<TSchema>,
  organizationId: string,
  work: (tx: Transaction<TSchema>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
    return work(tx);
  });
}

export function readiness(pool: pg.Pool) {
  const query = (pool as unknown as Queryable)[UNTRACED] ?? pool.query.bind(pool);
  return async () => {
    await query("select 1");
  };
}

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const UNAVAILABLE = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "57P01",
  "57P03",
  "3D000",
  "28P01",
]);
const UNAVAILABLE_MESSAGE = /connection terminated|timeout exceeded when trying to connect/i;

export function databaseUnavailable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const { code, message } = current as { code?: unknown; message?: unknown };
    if (typeof code === "string" && UNAVAILABLE.has(code)) return true;
    if (typeof message === "string" && UNAVAILABLE_MESSAGE.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export const isUniqueViolation = (error: unknown) => pgCode(error) === "23505";
export const isForeignKeyViolation = (error: unknown) => pgCode(error) === "23503";
export const isCheckViolation = (error: unknown) => pgCode(error) === "23514";
