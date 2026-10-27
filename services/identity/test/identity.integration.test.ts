import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createDatabase, createPool } from "@deus/db";
import { loadMigrations, migrate } from "@deus/db/migrate";
import { createLogger } from "@deus/logger";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { createLocalJWKSet, jwtVerify } from "jose";
import pg from "pg";
import { createApp } from "../src/app";
import { createAuth } from "../src/auth";
import { loadIdentityConfig } from "../src/config";
import { schema } from "../src/schema";

const url = process.env.DATABASE_TEST_URL;
const { telemetry } = startTestTelemetry("identity");
afterAll(() => telemetry.shutdown());

describe.skipIf(!url)("identity against PostgreSQL", () => {
  const admin = new pg.Client({ connectionString: url });
  const database = `identity_test_${process.pid}`;
  const target = new URL(url ?? "postgres://localhost");
  const env = {
    SERVICE_NAME: "identity",
    DB_HOST: target.hostname,
    DB_PORT: target.port || "5432",
    DB_NAME: database,
    DB_USER: "identity_app",
    DB_PASSWORD: "identity_app",
    BETTER_AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters",
    AUTH_BASE_URL: "http://localhost",
  };
  const config = loadIdentityConfig(env);
  const pool = createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    applicationName: "identity-test",
  });
  const auth = createAuth(
    {
      baseURL: config.AUTH_BASE_URL,
      secret: config.BETTER_AUTH_SECRET,
      trustedOrigins: [],
      issuer: config.AUTH_ISSUER,
    },
    createDatabase(pool, schema),
    schema,
  );
  const app = createApp(config, createLogger({ name: "identity" }), auth);
  const call = (path: string, init: RequestInit = {}) => app.handle(new Request(`http://localhost${path}`, init));
  const json = (body: unknown, cookie?: string) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    await admin.connect();
    await admin.query("drop role if exists identity_app");
    await admin.query("create role identity_app login password 'identity_app'");
    await admin.query(`create database ${database}`);
    const owner = new pg.Client({
      connectionString: Object.assign(new URL(target), { pathname: `/${database}` }).toString(),
    });
    await owner.connect();
    await migrate(owner, await loadMigrations(join(import.meta.dir, "../migrations")), { info: () => {} });
    await owner.end();
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.query("drop role if exists identity_app");
    await admin.end();
  });

  test("signs up, creates an organization and issues a token verifiable with the JWKS", async () => {
    const signUp = await call(
      "/api/identity/auth/sign-up/email",
      json({ email: "owner@example.com", password: "correct horse battery", name: "Owner" }),
    );
    expect(signUp.status).toBe(200);
    const cookie = (signUp.headers.getSetCookie() ?? []).map((value) => value.split(";")[0]).join("; ");
    expect(cookie).toContain("deus.session_token");

    const created = await call(
      "/api/identity/auth/organization/create",
      json({ name: "Toko Maju", slug: "toko-maju" }, cookie),
    );
    expect(created.status).toBe(200);
    const organization = (await created.json()) as { id: string };
    const activated = await call(
      "/api/identity/auth/organization/set-active",
      json({ organizationId: organization.id }, cookie),
    );
    expect(activated.status).toBe(200);

    const me = await call("/api/identity/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "owner@example.com", activeOrganizationId: organization.id });

    const tokenResponse = await call("/api/identity/auth/token", { headers: { cookie } });
    expect(tokenResponse.status).toBe(200);
    const { token } = (await tokenResponse.json()) as { token: string };
    const jwks = (await (await call("/api/identity/auth/jwks")).json()) as Parameters<typeof createLocalJWKSet>[0];
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: config.AUTH_ISSUER,
      audience: "deus",
    });
    expect(protectedHeader.alg).toBe("EdDSA");
    expect(payload).toMatchObject({ email: "owner@example.com", org: organization.id });
  });

  test("refuses /me without a session", async () => {
    const response = await call("/api/identity/me");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  });
});
