import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { SpanKind } from "@opentelemetry/api";
import { sql } from "drizzle-orm";
import pg from "pg";
import { createDatabase, createPool, operationName, readiness, withTenant } from "../src";
import { loadMigrations, MigrationError, migrate } from "../src/migrate";

const url = process.env.DATABASE_TEST_URL;
const { telemetry, spans } = startTestTelemetry("db-test");
afterAll(() => telemetry.shutdown());

test("names the operation of a statement", () => {
  expect(operationName("select 1")).toBe("SELECT");
  expect(operationName("  insert into t values (1)")).toBe("INSERT");
  expect(operationName("with x as (select 1) update t set a = 1")).toBe("UPDATE");
});

describe.skipIf(!url)("against PostgreSQL", () => {
  const admin = new pg.Client({ connectionString: url });
  const database = `deus_test_${process.pid}`;
  let directory = "";

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`create database ${database}`);
    await admin.query("drop role if exists tenant_app");
    await admin.query("create role tenant_app login password 'tenant_app'");
    directory = await mkdtemp(join(tmpdir(), "migrations-"));
  });

  afterAll(async () => {
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.query("drop role if exists tenant_app");
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });

  const owner = () => {
    const target = new URL(url ?? "");
    target.pathname = `/${database}`;
    return new pg.Client({ connectionString: target.toString() });
  };

  test("applies migrations once, in order, and refuses edited or missing ones", async () => {
    await writeFile(
      join(directory, "0000_entries.sql"),
      [
        "create table entries (id serial primary key, organization_id uuid not null, note text not null);",
        "alter table entries enable row level security;",
        "create policy entries_tenant on entries using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);",
        "grant select, insert on entries to tenant_app;",
        "grant usage on sequence entries_id_seq to tenant_app;",
      ].join("\n"),
    );
    await writeFile(
      join(directory, "0001_entries_note_idx.sql"),
      "create index concurrently entries_note_idx on entries (note);",
    );
    const client = owner();
    await client.connect();
    const logger = { info: () => {} };
    expect(await migrate(client, await loadMigrations(directory), logger)).toEqual([
      "0000_entries",
      "0001_entries_note_idx",
    ]);
    expect(await migrate(client, await loadMigrations(directory), logger)).toEqual([]);

    await writeFile(join(directory, "0000_entries.sql"), "select 1;");
    expect(migrate(client, await loadMigrations(directory), logger)).rejects.toThrow(MigrationError);
    await rm(join(directory, "0000_entries.sql"));
    expect(migrate(client, await loadMigrations(directory), logger)).rejects.toThrow("missing from the image");
    await client.end();
  });

  test("rejects a CONCURRENTLY migration with more than one statement", async () => {
    const other = await mkdtemp(join(tmpdir(), "migrations-"));
    await writeFile(
      join(other, "0000_bad.sql"),
      "create index concurrently a on t (a); create index concurrently b on t (b);",
    );
    expect(loadMigrations(other)).rejects.toThrow("exactly one statement");
    await rm(other, { recursive: true, force: true });
  });

  test("scopes every query of a tenant transaction with row level security", async () => {
    const target = new URL(url ?? "");
    const pool = createPool({
      host: target.hostname,
      port: Number(target.port || 5432),
      database,
      user: "tenant_app",
      password: "tenant_app",
      applicationName: "db-test",
    });
    try {
      await assertTenantIsolation(createDatabase(pool, {}));
      await readiness(pool)();
      const probes = spans.getFinishedSpans().filter((span) => span.attributes["db.query.text"] === "select 1");
      expect(probes).toHaveLength(0);
    } finally {
      await pool.end();
    }
  });

  async function assertTenantIsolation(db: ReturnType<typeof createDatabase>) {
    const tenantA = "00000000-0000-0000-0000-00000000000a";
    const tenantB = "00000000-0000-0000-0000-00000000000b";
    await withTenant(db, tenantA, (tx) =>
      tx.execute(sql`insert into entries (organization_id, note) values (${tenantA}, 'a')`),
    );
    await withTenant(db, tenantB, (tx) =>
      tx.execute(sql`insert into entries (organization_id, note) values (${tenantB}, 'b')`),
    );
    const seenByA = await withTenant(db, tenantA, (tx) => tx.execute(sql`select note from entries`));
    expect(seenByA.rows).toEqual([{ note: "a" }]);
    const withoutTenant = await db.execute(sql`select note from entries`);
    expect(withoutTenant.rows).toEqual([]);
    expect(
      withTenant(db, tenantA, (tx) =>
        tx.execute(sql`insert into entries (organization_id, note) values (${tenantB}, 'x')`),
      ),
    ).rejects.toThrow();

    const query = spans
      .getFinishedSpans()
      .find(
        (span) => span.kind === SpanKind.CLIENT && String(span.attributes["db.query.text"]).startsWith("select note"),
      );
    expect(query?.name).toBe(`SELECT ${database}`);
    expect(query?.attributes["db.namespace"]).toBe(database);
    expect(query?.attributes["db.system.name"]).toBe("postgresql");
    expect(query?.attributes["db.operation.name"]).toBe("SELECT");

    await db.execute(sql`select count(*) from entries`);
    const outsideTransaction = spans
      .getFinishedSpans()
      .filter(
        (span) => span.kind === SpanKind.CLIENT && span.attributes["db.query.text"] === "select count(*) from entries",
      );
    expect(outsideTransaction).toHaveLength(1);
    expect(outsideTransaction[0]?.attributes["db.operation.name"]).toBe("SELECT");
  }
});
