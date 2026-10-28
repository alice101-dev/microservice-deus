import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ServiceVerifier, Verifier } from "@deus/auth";
import type { AccountRef, ContactRef, JournalRequest, Ledger, ProductRef, ReversalRequest } from "@deus/clients";
import { loadConfig } from "@deus/config";
import { createTestDatabase } from "@deus/db/testing";
import { NotFoundError } from "@deus/errors";
import { createLogger } from "@deus/logger";
import { sum, toCents } from "@deus/money";
import { createRelay } from "@deus/outbox";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { sql } from "drizzle-orm";
import { createApp, TOPICS } from "../src/app";
import { salesHandlers } from "../src/handlers";
import { outbox, schema } from "../src/schema";

const url = process.env.DATABASE_TEST_URL;
const { telemetry } = startTestTelemetry("sales");
afterAll(() => telemetry.shutdown());

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const USER = "00000000-0000-4000-8000-000000000001";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CUSTOMER = id(201);
const VENDOR_ONLY = id(202);
const KOPI = id(301);
const JASA = id(302);
const SALES_REVENUE = id(401);
const SERVICE_REVENUE = id(402);
const REVENUE_HEADER = id(400);
const RECEIVABLE = id(112);
const VAT_OUTPUT = id(211);

const account = (accountId: string, code: string, type: AccountRef["type"], postable = true): AccountRef => ({
  id: accountId,
  code,
  name: code,
  type,
  parentId: null,
  active: true,
  postable,
});
const ACCOUNTS = [
  account(SALES_REVENUE, "4-1000", "revenue"),
  account(SERVICE_REVENUE, "4-2000", "revenue"),
  account(REVENUE_HEADER, "4-0000", "revenue", false),
  account(RECEIVABLE, "1-1200", "asset"),
  account(VAT_OUTPUT, "2-1100", "liability"),
];
const contact = (contactId: string, name: string, isCustomer: boolean): ContactRef => ({
  id: contactId,
  name,
  isCustomer,
  isVendor: !isCustomer,
  email: null,
  taxId: null,
  address: null,
  paymentTermsDays: 14,
  active: true,
});
const CONTACTS = [contact(CUSTOMER, "PT Pelanggan Setia", true), contact(VENDOR_ONLY, "CV Pemasok", false)];
const product = (productId: string, sku: string, salePrice: string, vatRate: string, revenue: string): ProductRef => ({
  id: productId,
  sku,
  name: sku === "KOPI-250" ? "Kopi Arabika 250g" : "Jasa Konsultasi",
  kind: sku === "KOPI-250" ? "goods" : "service",
  unit: "pcs",
  salePrice,
  purchasePrice: null,
  vatRate,
  revenueAccountId: revenue,
  expenseAccountId: null,
  active: true,
});
const PRODUCTS = [
  product(KOPI, "KOPI-250", "85000", "11", SALES_REVENUE),
  product(JASA, "JASA-KONS", "1500000", "0", SERVICE_REVENUE),
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

interface InvoiceBody {
  id: string;
  number: string | null;
  status: string;
  dueDate: string;
  subtotal: string;
  vatTotal: string;
  total: string;
  amountDue: string;
  lines: Array<{ description: string; quantity: string; amount: string; vatAmount: string; revenueAccountId: string }>;
}

describe.skipIf(!url)("sales against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase<typeof schema>>>;
  let app: ReturnType<typeof createApp>;
  const call = (path: string, token: string, init: { method?: string; body?: unknown } = {}) =>
    app.handle(
      new Request(`http://localhost/api/sales${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
    );
  const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;
  const draft = (extra: Record<string, unknown> = {}) => ({
    contactId: CUSTOMER,
    issueDate: "2026-03-10",
    lines: [
      { productId: KOPI, quantity: "3" },
      { productId: JASA, quantity: "1.5" },
    ],
    ...extra,
  });
  const events = (topic: string) =>
    database.db.select().from(outbox).where(sql`${outbox.topic} = ${topic}`).orderBy(outbox.createdAt);

  beforeAll(async () => {
    database = await createTestDatabase({
      url: url ?? "",
      service: "sales",
      serviceDirectory: join(import.meta.dir, ".."),
      schema,
    });
    app = createApp({
      config: loadConfig({}, { SERVICE_NAME: "sales" }),
      logger: createLogger({ name: "sales" }),
      db: database.db,
      verify,
      verifyService,
      accounts: byIds(ACCOUNTS),
      accountsByCode: async (codes) => ACCOUNTS.filter((entry) => codes.includes(entry.code)),
      contacts: byIds(CONTACTS),
      products: byIds(PRODUCTS),
      receivableAccountCode: "1-1200",
      vatOutputAccountCode: "2-1100",
    });
  });
  afterAll(() => database.cleanup());

  test("prices a draft from the products and the customer's payment terms", async () => {
    const created = await call("/invoices", ORG_A, { method: "POST", body: draft() });
    expect(created.status).toBe(201);
    const invoice = await json<InvoiceBody>(created);
    expect(invoice).toMatchObject({
      number: null,
      status: "draft",
      dueDate: "2026-03-24",
      subtotal: "2505000.00",
      vatTotal: "28050.00",
      total: "2533050.00",
      amountDue: "2533050.00",
    });
    expect(invoice.lines.map((line) => [line.description, line.quantity, line.amount, line.vatAmount])).toEqual([
      ["Kopi Arabika 250g", "3", "255000.00", "28050.00"],
      ["Jasa Konsultasi", "1.5", "2250000.00", "0.00"],
    ]);
  });

  test("refuses drafts with a wrong contact, product data or revenue account", async () => {
    const refused = async (body: Record<string, unknown>) =>
      (await call("/invoices", ORG_A, { method: "POST", body: draft(body) })).status;
    expect(await refused({ contactId: VENDOR_ONLY })).toBe(422);
    expect(await refused({ contactId: id(999) })).toBe(422);
    expect(await refused({ lines: [{ productId: id(998), quantity: "1" }] })).toBe(422);
    expect(
      await refused({ lines: [{ description: "Tanpa harga", quantity: "1", revenueAccountId: SALES_REVENUE }] }),
    ).toBe(422);
    expect(
      await refused({
        lines: [{ description: "Akun induk", quantity: "1", unitPrice: "10", revenueAccountId: REVENUE_HEADER }],
      }),
    ).toBe(422);
    expect(await refused({ lines: [{ productId: KOPI, quantity: "0.0000" }] })).toBe(422);
    expect(await refused({ lines: [{ productId: KOPI, quantity: "-1" }] })).toBe(400);
    expect(await refused({ dueDate: "2026-03-01" })).toBe(422);
  });

  test("issues with a yearly number and writes a balanced journal to the outbox in the same transaction", async () => {
    const first = await json<InvoiceBody>(call("/invoices", ORG_A, { method: "POST", body: draft() }));
    const issued = await json<InvoiceBody>(call(`/invoices/${first.id}/issue`, ORG_A, { method: "POST" }));
    expect(issued).toMatchObject({ status: "issued", number: "INV/2026/0001" });
    expect((await call(`/invoices/${first.id}/issue`, ORG_A, { method: "POST" })).status).toBe(409);
    expect((await call(`/invoices/${first.id}`, ORG_A, { method: "PUT", body: draft() })).status).toBe(409);

    const second = await json<InvoiceBody>(call("/invoices", ORG_A, { method: "POST", body: draft() }));
    expect((await json<InvoiceBody>(call(`/invoices/${second.id}/issue`, ORG_A, { method: "POST" }))).number).toBe(
      "INV/2026/0002",
    );
    const nextYear = await json<InvoiceBody>(
      call("/invoices", ORG_A, { method: "POST", body: draft({ issueDate: "2027-01-02" }) }),
    );
    expect((await json<InvoiceBody>(call(`/invoices/${nextYear.id}/issue`, ORG_A, { method: "POST" }))).number).toBe(
      "INV/2027/0001",
    );
    const other = await json<InvoiceBody>(call("/invoices", ORG_B, { method: "POST", body: draft() }));
    expect((await json<InvoiceBody>(call(`/invoices/${other.id}/issue`, ORG_B, { method: "POST" }))).number).toBe(
      "INV/2026/0001",
    );

    const journal = (await events(TOPICS.journal)).find(
      (event) => (event.payload as JournalRequest).sourceId === first.id,
    )?.payload as JournalRequest;
    expect(journal).toMatchObject({ organizationId: ORG_A, createdBy: USER, date: "2026-03-10" });
    expect(journal.lines).toEqual([
      { accountId: RECEIVABLE, debit: "2533050.00", memo: "Piutang INV/2026/0001" },
      { accountId: SALES_REVENUE, credit: "255000.00", memo: "Pendapatan" },
      { accountId: SERVICE_REVENUE, credit: "2250000.00", memo: "Pendapatan" },
      { accountId: VAT_OUTPUT, credit: "28050.00", memo: "PPN Keluaran" },
    ]);
    const debit = sum(journal.lines.flatMap((line) => (line.debit ? [line.debit] : [])));
    const credit = sum(journal.lines.flatMap((line) => (line.credit ? [line.credit] : [])));
    expect(debit).toBe(credit);
  });

  test("delivers the outbox to the ledger with the event id as idempotency key", async () => {
    const posted: Array<{ journal: JournalRequest; key: string }> = [];
    const reversed: ReversalRequest[] = [];
    let journalReady = false;
    const ledger: Ledger = {
      post: async (journal, key) => {
        posted.push({ journal, key });
        journalReady = true;
        return { id: id(900 + posted.length) };
      },
      reverse: async (reversal) => {
        if (!journalReady) throw new NotFoundError("no journal yet");
        reversed.push(reversal);
        return { id: id(950) };
      },
    };
    const invoice = await json<InvoiceBody>(call("/invoices", ORG_A, { method: "POST", body: draft() }));
    await call(`/invoices/${invoice.id}/issue`, ORG_A, { method: "POST" });
    const voided = await json<InvoiceBody>(
      call(`/invoices/${invoice.id}/void`, ORG_A, { method: "POST", body: { date: "2026-03-31" } }),
    );
    expect(voided).toMatchObject({ status: "void", amountDue: "0.00" });
    expect((await call(`/invoices/${invoice.id}/void`, ORG_A, { method: "POST" })).status).toBe(409);

    await database.db.execute(sql`update outbox set delivered_at = now() where payload->>'sourceId' <> ${invoice.id}`);
    const [reversalEvent] = await events(TOPICS.reversal);
    await database.db.execute(
      sql`update outbox set created_at = now() - interval '1 hour', available_at = now() - interval '1 hour' where id = ${reversalEvent?.id}`,
    );
    const relay = createRelay({
      db: database.db,
      logger: createLogger({ name: "sales" }),
      handlers: salesHandlers(ledger),
    });
    await relay.runOnce();
    expect(reversed).toHaveLength(0);
    expect(posted.map((entry) => entry.journal.sourceId)).toEqual([invoice.id]);
    const [journalEvent] = (await events(TOPICS.journal)).filter(
      (event) => (event.payload as JournalRequest).sourceId === invoice.id,
    );
    expect(posted[0]?.key).toBe(journalEvent?.id ?? "missing");

    await database.db.execute(sql`update outbox set available_at = now() where id = ${reversalEvent?.id}`);
    await relay.runOnce();
    expect(reversed).toEqual([
      {
        organizationId: ORG_A,
        createdBy: USER,
        sourceId: invoice.id,
        date: "2026-03-31",
        description: "Void invoice INV/2026/0003",
      },
    ]);
  });

  test("never voids a paid invoice and deletes only drafts", async () => {
    const paid = await json<InvoiceBody>(call("/invoices", ORG_A, { method: "POST", body: draft() }));
    await call(`/invoices/${paid.id}/issue`, ORG_A, { method: "POST" });
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.organization_id', ${ORG_A}, true)`);
      await tx.execute(sql`update invoices set amount_paid = 1000 where id = ${paid.id}`);
    });
    expect((await call(`/invoices/${paid.id}/void`, ORG_A, { method: "POST" })).status).toBe(409);
    expect((await call(`/invoices/${paid.id}`, ORG_A, { method: "DELETE" })).status).toBe(409);

    const removable = await json<InvoiceBody>(call("/invoices", ORG_A, { method: "POST", body: draft() }));
    const replaced = await json<InvoiceBody>(
      call(`/invoices/${removable.id}`, ORG_A, {
        method: "PUT",
        body: draft({
          lines: [
            {
              description: "Ongkos kirim",
              quantity: "1",
              unitPrice: "20000",
              vatRate: "0",
              revenueAccountId: SALES_REVENUE,
            },
          ],
        }),
      }),
    );
    expect(replaced).toMatchObject({ total: "20000.00", lines: [{ description: "Ongkos kirim" }] });
    expect((await call(`/invoices/${removable.id}`, ORG_A, { method: "DELETE" })).status).toBe(204);
    expect((await call(`/invoices/${removable.id}`, ORG_A)).status).toBe(404);
  });

  test("lists by status and keeps organizations apart", async () => {
    const issued = await json<InvoiceBody[]>(call("/invoices?status=issued", ORG_A));
    expect(issued.every((invoice) => invoice.status === "issued")).toBe(true);
    expect(issued.map((invoice) => invoice.number).sort()).toEqual([
      "INV/2026/0001",
      "INV/2026/0002",
      "INV/2026/0004",
      "INV/2027/0001",
    ]);
    expect(toCents(issued[0]?.total ?? "0")).toBeGreaterThan(0n);
    const ofB = await json<InvoiceBody[]>(call("/invoices", ORG_B));
    expect(ofB).toHaveLength(1);
    expect((await call(`/invoices/${issued[0]?.id}`, ORG_B)).status).toBe(404);
  });

  test("applies payment allocations once, refuses overpayment and takes them back", async () => {
    const invoice = await json<InvoiceBody>(call("/invoices", ORG_A, { method: "POST", body: draft() }));
    await call(`/invoices/${invoice.id}/issue`, ORG_A, { method: "POST" });
    const internal = (path: string, body: unknown, token = "svc:payments") =>
      app.handle(
        new Request(`http://localhost/internal/sales${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }),
      );
    const payment = id(700);
    const allocation = (allocationId: number, amount: string) => ({
      id: id(allocationId),
      documentId: invoice.id,
      amount,
    });
    const first = await internal("/allocations", {
      organizationId: ORG_A,
      paymentId: payment,
      allocations: [allocation(701, "1000000")],
    });
    expect(await first.json()).toEqual({ applied: 1 });
    const replay = await internal("/allocations", {
      organizationId: ORG_A,
      paymentId: payment,
      allocations: [allocation(701, "1000000")],
    });
    expect(await replay.json()).toEqual({ applied: 0 });
    const state = async () =>
      json<InvoiceBody & { amountPaid: string; paymentStatus: string }>(call(`/invoices/${invoice.id}`, ORG_A));
    expect(await state()).toMatchObject({
      amountPaid: "1000000.00",
      amountDue: "1533050.00",
      paymentStatus: "partial",
    });

    const over = await internal("/allocations", {
      organizationId: ORG_A,
      paymentId: id(710),
      allocations: [allocation(711, "500000"), allocation(712, "1100000")],
    });
    expect(over.status).toBe(422);
    expect((await state()).amountPaid).toBe("1000000.00");
    expect(
      (
        await internal("/allocations", {
          organizationId: ORG_A,
          paymentId: id(720),
          allocations: [allocation(721, "1533050")],
        })
      ).status,
    ).toBe(200);
    expect(await state()).toMatchObject({ amountDue: "0.00", paymentStatus: "paid" });

    const lookup = await app.handle(
      new Request(`http://localhost/internal/sales/invoices/lookup?organizationId=${ORG_A}&id=${invoice.id}`, {
        headers: { authorization: "Bearer svc:payments" },
      }),
    );
    expect(await lookup.json()).toEqual([
      expect.objectContaining({ id: invoice.id, status: "issued", contactId: CUSTOMER, amountDue: "0.00" }),
    ]);

    const reversed = await internal("/allocations/reverse", { organizationId: ORG_A, paymentId: payment });
    expect(await reversed.json()).toEqual({ reversed: 1 });
    expect(
      await (await internal("/allocations/reverse", { organizationId: ORG_A, paymentId: payment })).json(),
    ).toEqual({ reversed: 0 });
    expect(await state()).toMatchObject({ amountPaid: "1533050.00", paymentStatus: "partial" });
    expect(
      (
        await internal(
          "/allocations",
          { organizationId: ORG_A, paymentId: payment, allocations: [allocation(799, "1")] },
          "svc:reporting",
        )
      ).status,
    ).toBe(403);
  });
});
