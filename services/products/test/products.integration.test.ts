import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ServiceVerifier, Verifier } from "@deus/auth";
import type { AccountRef } from "@deus/clients";
import { loadConfig } from "@deus/config";
import { createTestDatabase } from "@deus/db/testing";
import { createLogger } from "@deus/logger";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { createApp } from "../src/app";
import { schema } from "../src/schema";

const url = process.env.DATABASE_TEST_URL;
const { telemetry } = startTestTelemetry("products");
afterAll(() => telemetry.shutdown());

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const REVENUE = "00000000-0000-4000-8000-000000000401";
const REVENUE_HEADER = "00000000-0000-4000-8000-000000000400";
const EXPENSE = "00000000-0000-4000-8000-000000000501";
const CASH = "00000000-0000-4000-8000-000000000101";
const account = (id: string, code: string, type: AccountRef["type"], postable = true): AccountRef => ({
  id,
  code,
  name: code,
  type,
  parentId: null,
  active: true,
  postable,
});
const ACCOUNTS = [
  account(REVENUE, "4-1000", "revenue"),
  account(REVENUE_HEADER, "4-0000", "revenue", false),
  account(EXPENSE, "5-1000", "expense"),
  account(CASH, "1-1000", "asset"),
];
const verify: Verifier = async (token) => ({
  userId: "00000000-0000-4000-8000-000000000001",
  email: "user@example.com",
  organizationId: token,
  token,
});
const verifyService: ServiceVerifier = async (token) => {
  if (!token.startsWith("svc:")) throw new Error("not a service token");
  return { service: token.slice(4), namespace: "staging-deus" };
};

interface ProductBody {
  id: string;
  sku: string;
  unit: string;
  salePrice: string | null;
  vatRate: string;
  revenueAccountId: string | null;
}

describe.skipIf(!url)("products against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase<typeof schema>>>;
  let app: ReturnType<typeof createApp>;
  const call = (path: string, token: string, init: { method?: string; body?: unknown } = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
    );

  beforeAll(async () => {
    database = await createTestDatabase({
      url: url ?? "",
      service: "products",
      serviceDirectory: join(import.meta.dir, ".."),
      schema,
    });
    app = createApp({
      config: loadConfig({}, { SERVICE_NAME: "products" }),
      logger: createLogger({ name: "products" }),
      db: database.db,
      verify,
      verifyService,
      accounts: async (ids) => ACCOUNTS.filter((entry) => ids.includes(entry.id)),
    });
  });
  afterAll(() => database.cleanup());

  test("creates goods and services with normalized prices and defaults", async () => {
    const created = await call("/api/products", ORG_A, {
      method: "POST",
      body: {
        sku: "KOPI-250",
        name: "Kopi Arabika 250g",
        kind: "goods",
        salePrice: "85000",
        vatRate: "11",
        revenueAccountId: REVENUE,
      },
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      unit: "pcs",
      salePrice: "85000.00",
      vatRate: "11.00",
      revenueAccountId: REVENUE,
    });
    const service = (await (
      await call("/api/products", ORG_A, {
        method: "POST",
        body: { sku: "JASA-KONS", name: "Jasa Konsultasi", kind: "service", salePrice: "1500000", vatRate: "0" },
      })
    ).json()) as ProductBody;
    expect(service).toMatchObject({ unit: "jam", vatRate: "0.00" });
    const duplicate = await call("/api/products", ORG_A, {
      method: "POST",
      body: { sku: "KOPI-250", name: "Duplicate", kind: "goods" },
    });
    expect(duplicate.status).toBe(409);
    const found = (await (await call("/api/products?q=kopi", ORG_A)).json()) as ProductBody[];
    expect(found.map((row) => row.sku)).toEqual(["KOPI-250"]);
    const services = (await (await call("/api/products?kind=service", ORG_A)).json()) as ProductBody[];
    expect(services.map((row) => row.sku)).toEqual(["JASA-KONS"]);
  });

  test("refuses unknown, header and mistyped default accounts", async () => {
    const attempt = (body: Record<string, unknown>) =>
      call("/api/products", ORG_A, { method: "POST", body: { sku: "X-1", name: "X", kind: "goods", ...body } });
    expect((await attempt({ revenueAccountId: "00000000-0000-4000-8000-000000000999" })).status).toBe(422);
    expect((await attempt({ revenueAccountId: REVENUE_HEADER })).status).toBe(422);
    expect((await attempt({ revenueAccountId: EXPENSE })).status).toBe(422);
    expect((await attempt({ expenseAccountId: REVENUE })).status).toBe(422);
    expect((await attempt({ expenseAccountId: CASH, purchasePrice: "1000" })).status).toBe(201);
    expect((await attempt({ sku: "X-2", vatRate: "101" })).status).toBe(400);
    expect((await attempt({ sku: "X-3", salePrice: "-5" })).status).toBe(400);
  });

  test("updates prices and serves other services by organization", async () => {
    const [kopi] = (await (await call("/api/products?q=KOPI", ORG_A)).json()) as ProductBody[];
    const updated = await call(`/api/products/${kopi?.id}`, ORG_A, { method: "PATCH", body: { salePrice: "90000.5" } });
    expect(((await updated.json()) as ProductBody).salePrice).toBe("90000.50");
    expect((await call(`/api/products/${kopi?.id}`, ORG_B)).status).toBe(404);
    const lookup = (organizationId: string, token: string) =>
      call(`/internal/products/lookup?organizationId=${organizationId}&id=${kopi?.id}`, token);
    expect(((await (await lookup(ORG_A, "svc:sales")).json()) as ProductBody[]).map((row) => row.sku)).toEqual([
      "KOPI-250",
    ]);
    expect(await (await lookup(ORG_B, "svc:sales")).json()).toEqual([]);
    expect((await lookup(ORG_A, "svc:ledger")).status).toBe(403);
  });
});
