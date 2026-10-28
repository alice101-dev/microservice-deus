import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ServiceVerifier, Verifier } from "@deus/auth";
import { loadConfig } from "@deus/config";
import { createTestDatabase } from "@deus/db/testing";
import { createLogger } from "@deus/logger";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { createApp } from "../src/app";
import { schema } from "../src/schema";

const url = process.env.DATABASE_TEST_URL;
const { telemetry } = startTestTelemetry("organization");
afterAll(() => telemetry.shutdown());

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const verify: Verifier = async (token) => ({ userId: "u-1", email: "user@example.com", organizationId: token, token });

const verifyService: ServiceVerifier = async (token) => {
  if (!token.startsWith("svc:")) throw new Error("not a service token");
  return { service: token.slice(4), namespace: "staging-deus" };
};

describe.skipIf(!url)("organization against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase<typeof schema>>>;
  let app: ReturnType<typeof createApp>;
  const call = (token: string, init: { method?: string; body?: unknown } = {}) =>
    app.handle(
      new Request("http://localhost/api/organization/profile", {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
    );

  beforeAll(async () => {
    database = await createTestDatabase({
      url: url ?? "",
      service: "organization",
      serviceDirectory: join(import.meta.dir, ".."),
      schema,
    });
    app = createApp({
      config: loadConfig({}, { SERVICE_NAME: "organization" }),
      logger: createLogger({ name: "organization" }),
      db: database.db,
      verify,
      verifyService,
    });
  });
  afterAll(() => database.cleanup());

  test("creates and updates the profile of the active organization only", async () => {
    expect((await call(ORG_A)).status).toBe(404);
    const created = await call(ORG_A, {
      method: "PUT",
      body: { legalName: "PT Toko Maju", taxId: "0123456789012345", fiscalYearStartMonth: 4 },
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ organizationId: ORG_A, currency: "IDR", fiscalYearStartMonth: 4 });
    const updated = await call(ORG_A, { method: "PUT", body: { legalName: "PT Toko Maju Jaya" } });
    expect(await updated.json()).toMatchObject({
      legalName: "PT Toko Maju Jaya",
      taxId: null,
      fiscalYearStartMonth: 1,
    });
    expect((await call(ORG_B)).status).toBe(404);
  });

  test("validates the tax id and fiscal month", async () => {
    expect((await call(ORG_A, { method: "PUT", body: { legalName: "x", taxId: "12-34" } })).status).toBe(400);
    expect((await call(ORG_A, { method: "PUT", body: { legalName: "x", fiscalYearStartMonth: 13 } })).status).toBe(400);
  });

  test("serves the profile to other services by organization", async () => {
    const internal = (organizationId: string, token: string) =>
      app.handle(
        new Request(`http://localhost/internal/organization/profile?organizationId=${organizationId}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
    expect(((await (await internal(ORG_A, "svc:reporting")).json()) as { currency: string }).currency).toBe("IDR");
    expect((await internal("00000000-0000-4000-8000-0000000000ff", "svc:reporting")).status).toBe(404);
    expect((await internal(ORG_A, "svc:sales")).status).toBe(403);
  });
});
