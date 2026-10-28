import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ServiceVerifier, Verifier } from "@deus/auth";
import type { AccountRef, ContactRef, JournalRequest, ProductRef, ReversalRequest } from "@deus/clients";
import { loadConfig } from "@deus/config";
import { createTestDatabase } from "@deus/db/testing";
import { createLogger } from "@deus/logger";
import { sum } from "@deus/money";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { sql } from "drizzle-orm";
import { createApp, TOPICS } from "../src/app";
import { outbox, schema } from "../src/schema";

const url = process.env.DATABASE_TEST_URL;
const { telemetry } = startTestTelemetry("purchases");
afterAll(() => telemetry.shutdown());

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const USER = "00000000-0000-4000-8000-000000000001";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const VENDOR = id(201);
const CUSTOMER_ONLY = id(202);
const KOPI = id(301);
const INVENTORY = id(113);
const RENT = id(620);
const REVENUE = id(401);
const PAYABLE = id(210);
const VAT_INPUT = id(114);

const account = (accountId: string, code: string, type: AccountRef["type"]): AccountRef => ({
  id: accountId,
  code,
  name: code,
  type,
  parentId: null,
  active: true,
  postable: true,
});
const ACCOUNTS = [
  account(INVENTORY, "1-1300", "asset"),
  account(RENT, "6-2000", "expense"),
  account(REVENUE, "4-1000", "revenue"),
  account(PAYABLE, "2-1000", "liability"),
  account(VAT_INPUT, "1-1400", "asset"),
];
const contact = (contactId: string, name: string, isVendor: boolean): ContactRef => ({
  id: contactId,
  name,
  isCustomer: !isVendor,
  isVendor,
  email: null,
  taxId: null,
  address: null,
  paymentTermsDays: 30,
  active: true,
});
const CONTACTS = [contact(VENDOR, "CV Pemasok Jaya", true), contact(CUSTOMER_ONLY, "PT Pelanggan", false)];
const PRODUCTS: ProductRef[] = [
  {
    id: KOPI,
    sku: "KOPI-250",
    name: "Kopi Arabika 250g",
    kind: "goods",
    unit: "pcs",
    salePrice: "85000",
    purchasePrice: "60000",
    vatRate: "11.00",
    revenueAccountId: REVENUE,
    expenseAccountId: INVENTORY,
    active: true,
  },
];
const verify: Verifier = async (token) => ({ userId: USER, email: "user@example.com", organizationId: token, token });
const verifyService: ServiceVerifier = async (token) => {
  if (!token.startsWith("svc:")) throw new Error("not a service token");
  return { service: token.slice(4), namespace: "staging-deus" };
};
const byIds =
  <T extends { id: string }>(rows: T[]) =>
  async (ids: string[]) =>
    rows.filter((row) => ids.includes(row.id));

interface BillBody {
  id: string;
  number: string | null;
  vendorReference: string | null;
  status: string;
  dueDate: string;
  subtotal: string;
  vatTotal: string;
  total: string;
  lines: Array<{ description: string; amount: string; accountId: string }>;
}

describe.skipIf(!url)("purchases against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase<typeof schema>>>;
  let app: ReturnType<typeof createApp>;
  const call = (path: string, token: string, init: { method?: string; body?: unknown } = {}) =>
    app.handle(
      new Request(`http://localhost/api/purchases${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
    );
  const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;
  const draft = (extra: Record<string, unknown> = {}) => ({
    contactId: VENDOR,
    billDate: "2026-03-05",
    vendorReference: "PJ-7781",
    lines: [
      { productId: KOPI, quantity: "10" },
      { description: "Sewa gudang Maret", quantity: "1", unitPrice: "2000000", vatRate: "0", accountId: RENT },
    ],
    ...extra,
  });
  const events = (topic: string) =>
    database.db.select().from(outbox).where(sql`${outbox.topic} = ${topic}`).orderBy(outbox.createdAt);

  beforeAll(async () => {
    database = await createTestDatabase({
      url: url ?? "",
      service: "purchases",
      serviceDirectory: join(import.meta.dir, ".."),
      schema,
    });
    app = createApp({
      config: loadConfig({}, { SERVICE_NAME: "purchases" }),
      logger: createLogger({ name: "purchases" }),
      db: database.db,
      verify,
      verifyService,
      accounts: byIds(ACCOUNTS),
      accountsByCode: async (codes) => ACCOUNTS.filter((entry) => codes.includes(entry.code)),
      contacts: byIds(CONTACTS),
      products: byIds(PRODUCTS),
      payableAccountCode: "2-1000",
      vatInputAccountCode: "1-1400",
    });
  });
  afterAll(() => database.cleanup());

  test("prices a draft bill from purchase prices and expense accounts", async () => {
    const created = await call("/bills", ORG_A, { method: "POST", body: draft() });
    expect(created.status).toBe(201);
    const bill = await json<BillBody>(created);
    expect(bill).toMatchObject({
      number: null,
      vendorReference: "PJ-7781",
      status: "draft",
      dueDate: "2026-04-04",
      subtotal: "2600000.00",
      vatTotal: "66000.00",
      total: "2666000.00",
    });
    expect(bill.lines.map((line) => [line.amount, line.accountId])).toEqual([
      ["600000.00", INVENTORY],
      ["2000000.00", RENT],
    ]);
  });

  test("refuses customers, revenue accounts and a vendor invoice recorded twice", async () => {
    expect(
      (
        await call("/bills", ORG_A, {
          method: "POST",
          body: draft({ contactId: CUSTOMER_ONLY, vendorReference: "X1" }),
        })
      ).status,
    ).toBe(422);
    const revenueLine = draft({
      vendorReference: "X2",
      lines: [{ description: "Salah akun", quantity: "1", unitPrice: "10", accountId: REVENUE }],
    });
    expect((await call("/bills", ORG_A, { method: "POST", body: revenueLine })).status).toBe(422);
    expect((await call("/bills", ORG_A, { method: "POST", body: draft() })).status).toBe(409);
    expect((await call("/bills", ORG_B, { method: "POST", body: draft() })).status).toBe(201);
  });

  test("approves with a yearly number and posts Dr expense and VAT input, Cr payable through the outbox", async () => {
    const [bill] = await json<BillBody[]>(call("/bills?status=draft", ORG_A));
    const approved = await json<BillBody>(call(`/bills/${bill?.id}/approve`, ORG_A, { method: "POST" }));
    expect(approved).toMatchObject({ status: "approved", number: "BILL/2026/0001" });
    expect((await call(`/bills/${bill?.id}/approve`, ORG_A, { method: "POST" })).status).toBe(409);
    const [event] = await events(TOPICS.journal);
    const journal = event?.payload as JournalRequest;
    expect(journal).toMatchObject({ organizationId: ORG_A, date: "2026-03-05", sourceId: bill?.id });
    expect(journal.description).toBe("Bill BILL/2026/0001 (PJ-7781) - CV Pemasok Jaya");
    expect(journal.lines).toEqual([
      { accountId: INVENTORY, debit: "600000.00", memo: "Pembelian" },
      { accountId: RENT, debit: "2000000.00", memo: "Pembelian" },
      { accountId: VAT_INPUT, debit: "66000.00", memo: "PPN Masukan" },
      { accountId: PAYABLE, credit: "2666000.00", memo: "Utang BILL/2026/0001" },
    ]);
    const debit = sum(journal.lines.flatMap((line) => (line.debit ? [line.debit] : [])));
    const credit = sum(journal.lines.flatMap((line) => (line.credit ? [line.credit] : [])));
    expect(debit).toBe(credit);
  });

  test("voids an unpaid bill with a reversal and keeps organizations apart", async () => {
    const [bill] = await json<BillBody[]>(call("/bills?status=approved", ORG_A));
    const voided = await json<BillBody>(
      call(`/bills/${bill?.id}/void`, ORG_A, { method: "POST", body: { date: "2026-03-31" } }),
    );
    expect(voided.status).toBe("void");
    const [event] = await events(TOPICS.reversal);
    expect(event?.payload as ReversalRequest).toEqual({
      organizationId: ORG_A,
      createdBy: USER,
      sourceId: bill?.id ?? "",
      date: "2026-03-31",
      description: "Void bill BILL/2026/0001",
    });
    expect((await call(`/bills/${bill?.id}`, ORG_B)).status).toBe(404);
    expect(await json<BillBody[]>(call("/bills", ORG_B))).toHaveLength(1);
  });

  test("applies vendor payments to an approved bill once and takes them back", async () => {
    const bill = await json<BillBody>(
      call("/bills", ORG_A, { method: "POST", body: draft({ vendorReference: "PJ-9001" }) }),
    );
    await call(`/bills/${bill.id}/approve`, ORG_A, { method: "POST" });
    const internal = (path: string, body: unknown, token = "svc:payments") =>
      app.handle(
        new Request(`http://localhost/internal/purchases${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }),
      );
    const state = async () =>
      json<BillBody & { amountPaid: string; paymentStatus: string }>(call(`/bills/${bill.id}`, ORG_A));
    const apply = (allocationId: number, amount: string) =>
      internal("/allocations", {
        organizationId: ORG_A,
        paymentId: id(800),
        allocations: [{ id: id(allocationId), documentId: bill.id, amount }],
      });
    expect(await (await apply(801, "2666000")).json()).toEqual({ applied: 1 });
    expect(await (await apply(801, "2666000")).json()).toEqual({ applied: 0 });
    expect(await state()).toMatchObject({ amountPaid: "2666000.00", paymentStatus: "paid" });
    expect((await apply(802, "1")).status).toBe(422);
    expect((await call(`/bills/${bill.id}/void`, ORG_A, { method: "POST" })).status).toBe(409);
    expect(
      await (await internal("/allocations/reverse", { organizationId: ORG_A, paymentId: id(800) })).json(),
    ).toEqual({ reversed: 1 });
    expect(await state()).toMatchObject({ amountPaid: "0.00", paymentStatus: "unpaid" });
    expect(
      (await internal("/allocations/reverse", { organizationId: ORG_A, paymentId: id(800) }, "svc:sales")).status,
    ).toBe(403);
  });
});
