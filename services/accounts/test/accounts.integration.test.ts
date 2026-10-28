import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ServiceVerifier, Verifier } from "@deus/auth";
import { loadConfig } from "@deus/config";
import { createTestDatabase } from "@deus/db/testing";
import { createLogger } from "@deus/logger";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { createApp } from "../src/app";
import { DEFAULT_CHART } from "../src/defaults";
import { schema } from "../src/schema";

const url = process.env.DATABASE_TEST_URL;
const { telemetry } = startTestTelemetry("accounts");
afterAll(() => telemetry.shutdown());

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const verify: Verifier = async (token) => ({
  userId: "00000000-0000-4000-8000-000000000001",
  email: "user@example.com",
  organizationId: token === "no-org" ? null : token,
  token,
});

const verifyService: ServiceVerifier = async (token) => {
  if (!token.startsWith("svc:")) throw new Error("not a service token");
  return { service: token.slice(4), namespace: "staging-deus" };
};

describe.skipIf(!url)("accounts against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase<typeof schema>>>;
  let app: ReturnType<typeof createApp>;
  const call = (path: string, token: string | undefined, init: { method?: string; body?: unknown } = {}) =>
    app.handle(
      new Request(`http://localhost/api/accounts${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
    );

  beforeAll(async () => {
    database = await createTestDatabase({
      url: url ?? "",
      service: "accounts",
      serviceDirectory: join(import.meta.dir, ".."),
      schema,
    });
    app = createApp({
      config: loadConfig({}, { SERVICE_NAME: "accounts" }),
      logger: createLogger({ name: "accounts" }),
      db: database.db,
      verify,
      verifyService,
    });
  });
  afterAll(() => database.cleanup());

  test("creates the default chart once, with its hierarchy", async () => {
    const created = await call("/defaults", ORG_A, { method: "POST" });
    expect(created.status).toBe(201);
    const rows = (await created.json()) as Array<{
      id: string;
      code: string;
      parentId: string | null;
      postable: boolean;
    }>;
    expect(rows).toHaveLength(DEFAULT_CHART.length);
    const cash = rows.find((row) => row.code === "1-1000");
    expect(cash?.parentId).toBe(rows.find((row) => row.code === "1-0000")?.id ?? "missing");
    expect(rows.find((row) => row.code === "1-0000")?.postable).toBe(false);
    expect(cash?.postable).toBe(true);
    const lookup = (await (await call(`/lookup?id=${cash?.id}&id=${cash?.parentId}`, ORG_A)).json()) as Array<{
      code: string;
      postable: boolean;
    }>;
    expect(Object.fromEntries(lookup.map((row) => [row.code, row.postable]))).toEqual({
      "1-0000": false,
      "1-1000": true,
    });
    expect((await call("/defaults", ORG_A, { method: "POST" })).status).toBe(409);
  });

  test("validates new accounts", async () => {
    const assets = ((await (await call("/", ORG_A)).json()) as Array<{ id: string; code: string }>).find(
      (row) => row.code === "1-0000",
    );
    const created = await call("/", ORG_A, {
      method: "POST",
      body: { code: "1-1110", name: "Bank BCA", type: "asset", parentId: assets?.id },
    });
    expect(created.status).toBe(201);
    expect(
      (await call("/", ORG_A, { method: "POST", body: { code: "1-1110", name: "Duplicate", type: "asset" } })).status,
    ).toBe(409);
    expect(
      (
        await call("/", ORG_A, {
          method: "POST",
          body: { code: "4-9000", name: "Wrong parent", type: "revenue", parentId: assets?.id },
        })
      ).status,
    ).toBe(422);
    expect((await call("/", ORG_A, { method: "POST", body: { code: "", name: "x", type: "asset" } })).status).toBe(400);
  });

  test("keeps organizations apart", async () => {
    const own = (await (await call("/", ORG_A)).json()) as Array<{ id: string }>;
    expect(own.length).toBeGreaterThan(0);
    expect(await (await call("/", ORG_B)).json()).toEqual([]);
    const lookup = await call(`/lookup?id=${own[0]?.id}`, ORG_B);
    expect(await lookup.json()).toEqual([]);
    const sameTenant = await call(`/lookup?id=${own[0]?.id}&id=${own[1]?.id}`, ORG_A);
    expect((await sameTenant.json()) as unknown[]).toHaveLength(2);
  });

  test("deactivates an account", async () => {
    const [first] = (await (await call("/", ORG_A)).json()) as Array<{ id: string }>;
    const updated = await call(`/${first?.id}`, ORG_A, { method: "PATCH", body: { active: false } });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ active: false });
    expect((await call(`/${first?.id}`, ORG_B, { method: "PATCH", body: { active: false } })).status).toBe(404);
  });

  test("requires a token and an active organization", async () => {
    expect((await call("/", undefined)).status).toBe(401);
    expect((await call("/", "no-org")).status).toBe(403);
  });

  test("serves other services the accounts of the organization they name", async () => {
    const own = (await (await call("/", ORG_A)).json()) as Array<{ id: string; code: string }>;
    const kas = own.find((row) => row.code === "1-1000");
    const aset = own.find((row) => row.code === "1-0000");
    const internal = (organizationId: string, token?: string) =>
      app.handle(
        new Request(
          `http://localhost/internal/accounts/lookup?organizationId=${organizationId}&id=${kas?.id}&id=${aset?.id}`,
          token ? { headers: { authorization: `Bearer ${token}` } } : {},
        ),
      );
    const found = await internal(ORG_A, "svc:ledger");
    expect(found.status).toBe(200);
    const rows = (await found.json()) as Array<{ code: string; postable: boolean }>;
    expect(Object.fromEntries(rows.map((row) => [row.code, row.postable]))).toEqual({
      "1-0000": false,
      "1-1000": true,
    });
    expect(await (await internal(ORG_B, "svc:ledger")).json()).toEqual([]);
    expect((await internal(ORG_A, "svc:notification")).status).toBe(403);
    expect((await internal(ORG_A, ORG_A)).status).toBe(401);
    expect((await internal(ORG_A)).status).toBe(401);
  });
});
