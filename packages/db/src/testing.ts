import { join } from "node:path";
import pg from "pg";
import { createDatabase, createPool } from "./index";
import { loadMigrations, migrate } from "./migrate";

export async function createTestDatabase<S extends Record<string, unknown>>(options: {
  url: string;
  service: string;
  serviceDirectory: string;
  schema: S;
}) {
  const admin = new pg.Client({ connectionString: options.url });
  await admin.connect();
  const database = `${options.service}_test_${process.pid}`;
  const role = `${options.service}_app`;
  await admin.query(`drop database if exists ${database} with (force)`);
  await admin.query(`drop role if exists ${role}`);
  await admin.query(`create role ${role} login password '${role}'`);
  await admin.query(`create database ${database}`);
  const target = new URL(options.url);
  target.pathname = `/${database}`;
  const owner = new pg.Client({ connectionString: target.toString() });
  await owner.connect();
  await migrate(owner, await loadMigrations(join(options.serviceDirectory, "migrations")), { info: () => {} });
  await owner.end();
  const pool = createPool({
    host: target.hostname,
    port: Number(target.port || 5432),
    database,
    user: role,
    password: role,
    applicationName: `${options.service}-test`,
  });
  return {
    pool,
    db: createDatabase(pool, options.schema),
    async cleanup() {
      await pool.end();
      await admin.query(`drop database if exists ${database} with (force)`);
      await admin.query(`drop role if exists ${role}`);
      await admin.end();
    },
  };
}
