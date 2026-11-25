import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { databaseUnavailable } from "./index";

export interface Migration {
  id: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

export interface MigrateLogger {
  info(message: string, attributes?: Record<string, string | number | boolean>): void;
}

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
  }
}

const LOCK_KEY = 7_401_531_118;
export async function connectWhenReady<T>(
  connect: () => Promise<T>,
  logger: MigrateLogger,
  { timeoutMs = 480_000, maxDelayMs = 15_000, sleep = (ms: number) => Bun.sleep(ms) } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect();
    } catch (error) {
      if (!databaseUnavailable(error) || Date.now() >= deadline) throw error;
      const delay = Math.min(1000 * 2 ** (attempt - 1), maxDelayMs);
      logger.info("waiting for the database", {
        attempt,
        reason: String((error as { code?: unknown }).code ?? (error as Error).message),
        "retry.delay_ms": delay,
      });
      await sleep(delay);
    }
  }
}

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  return Promise.all(
    files.map(async (file) => {
      const text = await Bun.file(join(directory, file)).text();
      const concurrent = /\bconcurrently\b/i.test(text);
      if (concurrent && text.trim().replace(/;\s*$/, "").includes(";")) {
        throw new MigrationError(`${file}: a CONCURRENTLY migration must contain exactly one statement`);
      }
      return {
        id: file.replace(/\.sql$/, ""),
        sql: text,
        checksum: createHash("sha256").update(text).digest("hex"),
        transactional: !concurrent,
      };
    }),
  );
}

export async function migrate(
  client: pg.Client | pg.PoolClient,
  migrations: Migration[],
  logger: MigrateLogger,
  options: { lockTimeoutMs?: number; statementTimeoutMs?: number } = {},
): Promise<string[]> {
  await client.query(`set lock_timeout = ${options.lockTimeoutMs ?? 5000}`);
  await client.query(`set statement_timeout = ${options.statementTimeoutMs ?? 900000}`);
  await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query(
      "create table if not exists schema_migrations (id text primary key, checksum text not null, applied_at timestamptz not null default now())",
    );
    const { rows } = await client.query<{ id: string; checksum: string }>("select id, checksum from schema_migrations");
    const applied = new Map(rows.map((row) => [row.id, row.checksum]));
    const known = new Set(migrations.map((migration) => migration.id));
    for (const id of applied.keys()) {
      if (!known.has(id)) throw new MigrationError(`${id} is applied but missing from the image`);
    }
    const done: string[] = [];
    for (const migration of migrations) {
      const checksum = applied.get(migration.id);
      if (checksum !== undefined) {
        if (checksum !== migration.checksum) throw new MigrationError(`${migration.id} changed after it was applied`);
        continue;
      }
      const started = performance.now();
      if (migration.transactional) {
        await client.query("begin");
        try {
          await client.query(migration.sql);
          await client.query("insert into schema_migrations (id, checksum) values ($1, $2)", [
            migration.id,
            migration.checksum,
          ]);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw new MigrationError(`${migration.id} failed`, { cause: error });
        }
      } else {
        try {
          await client.query(migration.sql);
        } catch (error) {
          throw new MigrationError(`${migration.id} failed`, { cause: error });
        }
        await client.query("insert into schema_migrations (id, checksum) values ($1, $2)", [
          migration.id,
          migration.checksum,
        ]);
      }
      logger.info("migration applied", {
        "migration.id": migration.id,
        "migration.transactional": migration.transactional,
        "duration.ms": Math.round(performance.now() - started),
      });
      done.push(migration.id);
    }
    return done;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

export interface MigrationJobOptions {
  directory: string;
  connection: { host: string; port: number; database: string; user: string; password: string };
  logger: MigrateLogger & { error(message: string, attributes?: Record<string, string>, error?: unknown): void };
  flush: () => Promise<void>;
}

export async function runMigrationJob(options: MigrationJobOptions): Promise<never> {
  const { default: pg } = await import("pg");
  let client: pg.Client | undefined;
  let code = 0;
  try {
    client = await connectWhenReady(async () => {
      const candidate = new pg.Client({ ...options.connection, application_name: "migrations" });
      try {
        await candidate.connect();
        return candidate;
      } catch (error) {
        await candidate.end().catch(() => {});
        throw error;
      }
    }, options.logger);
    const applied = await migrate(client, await loadMigrations(options.directory), options.logger);
    options.logger.info("migrations complete", {
      "migration.applied": applied.length,
      database: options.connection.database,
    });
  } catch (error) {
    code = 1;
    options.logger.error("migrations failed", { database: options.connection.database }, error);
  } finally {
    await client?.end().catch(() => {});
    await options.flush();
  }
  process.exit(code);
}
