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
const { telemetry } = startTestTelemetry("contacts");
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

interface ContactBody {
  id: string;
  name: string;
  isCustomer: boolean;
  isVendor: boolean;
  paymentTermsDays: number;
  active: boolean;
}

describe.skipIf(!url)("contacts against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase<typeof schema>>>;
  let app: ReturnType<typeof createApp>;
  const call = (path: string, token: string | undefined, init: { method?: string; body?: unknown } = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
    );
  const create = async (token: string, body: Record<string, unknown>) =>
    (await (await call("/api/contacts", token, { method: "POST", body })).json()) as ContactBody;

  beforeAll(async () => {
    database = await createTestDatabase({
      url: url ?? "",
      service: "contacts",
      serviceDirectory: join(import.meta.dir, ".."),
      schema,
    });
    app = createApp({
      config: loadConfig({}, { SERVICE_NAME: "contacts" }),
      logger: createLogger({ name: "contacts" }),
      db: database.db,
      verify,
      verifyService,
    });
  });
  afterAll(() => database.cleanup());

  test("creates customers and vendors and filters them", async () => {
    const customer = await create(ORG_A, {
      name: "PT Pelanggan Setia",
      isCustomer: true,
      isVendor: false,
      email: "finance@pelanggan.example",
      taxId: "0123456789012345",
    });
    expect(customer).toMatchObject({ isCustomer: true, paymentTermsDays: 30, active: true });
    await create(ORG_A, { name: "CV Pemasok Jaya", isCustomer: false, isVendor: true, paymentTermsDays: 14 });
    await create(ORG_A, { name: "Toko 50%_Diskon", isCustomer: true, isVendor: true });

    const names = async (query: string) =>
      ((await (await call(`/api/contacts${query}`, ORG_A)).json()) as ContactBody[]).map((row) => row.name);
    expect(await names("")).toEqual(["CV Pemasok Jaya", "PT Pelanggan Setia", "Toko 50%_Diskon"]);
    expect(await names("?role=customer")).toEqual(["PT Pelanggan Setia", "Toko 50%_Diskon"]);
    expect(await names("?role=vendor")).toEqual(["CV Pemasok Jaya", "Toko 50%_Diskon"]);
    expect(await names("?q=50%25_")).toEqual(["Toko 50%_Diskon"]);
    expect(await names("?q=jaya")).toEqual(["CV Pemasok Jaya"]);
  });

  test("validates contacts", async () => {
    const invalid = (body: Record<string, unknown>) => call("/api/contacts", ORG_A, { method: "POST", body });
    expect((await invalid({ name: "Nobody", isCustomer: false, isVendor: false })).status).toBe(422);
    expect((await invalid({ name: "Bad NPWP", isCustomer: true, isVendor: false, taxId: "12-34" })).status).toBe(400);
    expect((await invalid({ name: "Bad email", isCustomer: true, isVendor: false, email: "nope" })).status).toBe(400);
    const contact = await create(ORG_A, { name: "PT Sementara", isCustomer: true, isVendor: false });
    const roleless = await call(`/api/contacts/${contact.id}`, ORG_A, {
      method: "PATCH",
      body: { isCustomer: false },
    });
    expect(roleless.status).toBe(422);
    const deactivated = await call(`/api/contacts/${contact.id}`, ORG_A, { method: "PATCH", body: { active: false } });
    expect(((await deactivated.json()) as ContactBody).active).toBe(false);
  });

  test("keeps organizations apart and serves other services by organization", async () => {
    const own = (await (await call("/api/contacts", ORG_A)).json()) as ContactBody[];
    const id = own[0]?.id ?? "";
    expect((await call(`/api/contacts/${id}`, ORG_B)).status).toBe(404);
    expect(await (await call("/api/contacts", ORG_B)).json()).toEqual([]);
    const lookup = (organizationId: string, token: string) =>
      call(`/internal/contacts/lookup?organizationId=${organizationId}&id=${id}`, token);
    expect(((await (await lookup(ORG_A, "svc:sales")).json()) as ContactBody[]).map((row) => row.id)).toEqual([id]);
    expect(await (await lookup(ORG_B, "svc:sales")).json()).toEqual([]);
    expect((await lookup(ORG_A, "svc:ledger")).status).toBe(403);
    expect((await call("/api/contacts", "no-org")).status).toBe(403);
    expect((await call("/api/contacts", undefined)).status).toBe(401);
  });
});
