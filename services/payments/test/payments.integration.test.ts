import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ServiceVerifier, Verifier } from "@deus/auth";
import type {
  AccountRef,
  AllocationRequest,
  Allocations,
  ContactRef,
  DocumentRef,
  JournalRequest,
  Ledger,
} from "@deus/clients";
import { loadConfig } from "@deus/config";
import { createTestDatabase } from "@deus/db/testing";
import { createLogger } from "@deus/logger";
import { createRelay } from "@deus/outbox";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { sql } from "drizzle-orm";
import { createApp, TOPICS } from "../src/app";
import { paymentHandlers } from "../src/handlers";
import { outbox, schema } from "../src/schema";

const url = process.env.DATABASE_TEST_URL;
const { telemetry } = startTestTelemetry("payments");
afterAll(() => telemetry.shutdown());

const ORG = "00000000-0000-4000-8000-00000000000a";
const USER = "00000000-0000-4000-8000-000000000001";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CUSTOMER = id(201);
const VENDOR = id(202);
const BANK = id(111);
const RECEIVABLE = id(112);
const PAYABLE = id(210);
const REVENUE = id(401);
const INVOICE_1 = id(501);
const INVOICE_2 = id(502);
const OTHER_CUSTOMER_INVOICE = id(503);
const DRAFT_INVOICE = id(504);
const BILL = id(601);

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
  account(BANK, "1-1100", "asset"),
  account(RECEIVABLE, "1-1200", "asset"),
  account(PAYABLE, "2-1000", "liability"),
  account(REVENUE, "4-1000", "revenue"),
];
const contact = (contactId: string, name: string, isCustomer: boolean): ContactRef => ({
  id: contactId,
  name,
  isCustomer,
  isVendor: !isCustomer,
  email: null,
  taxId: null,
  address: null,
  paymentTermsDays: 30,
  active: true,
});
const CONTACTS = [contact(CUSTOMER, "PT Pelanggan Setia", true), contact(VENDOR, "CV Pemasok Jaya", false)];
const document = (documentId: string, number: string, status: string, contactId: string, due: string): DocumentRef => ({
  id: documentId,
  number,
  status,
  contactId,
  contactName: "x",
  date: "2026-03-01",
  dueDate: "2026-03-31",
  total: due,
  amountPaid: "0.00",
  amountDue: due,
});
const INVOICES = [
  document(INVOICE_1, "INV/2026/0001", "issued", CUSTOMER, "283050.00"),
  document(INVOICE_2, "INV/2026/0002", "issued", CUSTOMER, "100000.00"),
  document(OTHER_CUSTOMER_INVOICE, "INV/2026/0003", "issued", VENDOR, "5000.00"),
  document(DRAFT_INVOICE, "INV/2026/0004", "draft", CUSTOMER, "5000.00"),
];
const BILLS = [document(BILL, "BILL/2026/0001", "approved", VENDOR, "2666000.00")];
const verify: Verifier = async (token) => ({ userId: USER, email: "user@example.com", organizationId: token, token });
const verifyService: ServiceVerifier = async (token) => {
  if (!token.startsWith("svc:")) throw new Error("not a service token");
  return { service: token.slice(4), namespace: "staging-deus" };
};
const byIds =
  <T extends { id: string }>(rows: T[]) =>
  async (ids: string[]) =>
    rows.filter((row) => ids.includes(row.id));

interface PaymentBody {
  id: string;
  number: string;
  status: string;
  amount: string;
  allocations: Array<{ documentId: string; documentNumber: string; amount: string }>;
}

describe.skipIf(!url)("payments against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase<typeof schema>>>;
  let app: ReturnType<typeof createApp>;
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    app.handle(
      new Request(`http://localhost/api/payments${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${ORG}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
    );
  const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;
  const receipt = (extra: Record<string, unknown> = {}) => ({
    kind: "receipt",
    contactId: CUSTOMER,
    date: "2026-03-20",
    cashAccountId: BANK,
    amount: "383050",
    reference: "TRF-BCA-0320",
    allocations: [
      { documentId: INVOICE_1, amount: "283050" },
      { documentId: INVOICE_2, amount: "100000" },
    ],
    ...extra,
  });
  const events = (topic: string) =>
    database.db.select().from(outbox).where(sql`${outbox.topic} = ${topic}`).orderBy(outbox.createdAt);

  beforeAll(async () => {
    database = await createTestDatabase({
      url: url ?? "",
      service: "payments",
      serviceDirectory: join(import.meta.dir, ".."),
      schema,
    });
    app = createApp({
      config: loadConfig({}, { SERVICE_NAME: "payments" }),
      logger: createLogger({ name: "payments" }),
      db: database.db,
      verify,
      verifyService,
      accounts: byIds(ACCOUNTS),
      accountsByCode: async (codes) => ACCOUNTS.filter((entry) => codes.includes(entry.code)),
      contacts: byIds(CONTACTS),
      invoices: byIds(INVOICES),
      bills: byIds(BILLS),
      receivableAccountCode: "1-1200",
      payableAccountCode: "2-1000",
    });
  });
  afterAll(() => database.cleanup());

  test("validates the contact, cash account and allocations", async () => {
    const refused = async (extra: Record<string, unknown>) =>
      (await call("/", { method: "POST", body: receipt(extra) })).status;
    expect(await refused({ contactId: VENDOR })).toBe(422);
    expect(await refused({ cashAccountId: REVENUE })).toBe(422);
    expect(await refused({ amount: "383051" })).toBe(422);
    expect(await refused({ amount: "283051", allocations: [{ documentId: INVOICE_1, amount: "283051" }] })).toBe(422);
    expect(
      await refused({ amount: "5000", allocations: [{ documentId: OTHER_CUSTOMER_INVOICE, amount: "5000" }] }),
    ).toBe(422);
    expect(await refused({ amount: "5000", allocations: [{ documentId: DRAFT_INVOICE, amount: "5000" }] })).toBe(422);
    expect(
      await refused({
        amount: "2",
        allocations: [
          { documentId: INVOICE_2, amount: "1" },
          { documentId: INVOICE_2, amount: "1" },
        ],
      }),
    ).toBe(422);
  });

  test("records a receipt with Dr bank, Cr receivable and the allocations for sales", async () => {
    const created = await call("/", { method: "POST", body: receipt() });
    expect(created.status).toBe(201);
    const payment = await json<PaymentBody>(created);
    expect(payment).toMatchObject({ number: "RCV/2026/0001", status: "recorded", amount: "383050.00" });
    const journal = (await events(TOPICS.journal))[0]?.payload as JournalRequest;
    expect(journal).toMatchObject({
      date: "2026-03-20",
      sourceId: payment.id,
      description: "Receipt RCV/2026/0001 - PT Pelanggan Setia",
    });
    expect(journal.lines).toEqual([
      { accountId: BANK, debit: "383050.00", memo: "TRF-BCA-0320" },
      { accountId: RECEIVABLE, credit: "383050.00", memo: "INV/2026/0001, INV/2026/0002" },
    ]);
    const allocation = (await events(TOPICS.salesAllocations))[0]?.payload as AllocationRequest;
    expect(allocation.paymentId).toBe(payment.id);
    expect(allocation.allocations.map((entry) => [entry.documentId, entry.amount])).toEqual([
      [INVOICE_1, "283050.00"],
      [INVOICE_2, "100000.00"],
    ]);
  });

  test("records a vendor payment with Dr payable, Cr bank", async () => {
    const payment = await json<PaymentBody>(
      call("/", {
        method: "POST",
        body: {
          kind: "disbursement",
          contactId: VENDOR,
          date: "2026-04-02",
          cashAccountId: BANK,
          amount: "2666000",
          allocations: [{ documentId: BILL, amount: "2666000" }],
        },
      }),
    );
    expect(payment.number).toBe("PAY/2026/0001");
    const journal = (await events(TOPICS.journal)).find(
      (event) => (event.payload as JournalRequest).sourceId === payment.id,
    )?.payload as JournalRequest;
    expect(journal.lines).toEqual([
      { accountId: PAYABLE, debit: "2666000.00", memo: "BILL/2026/0001" },
      { accountId: BANK, credit: "2666000.00", memo: "PAY/2026/0001" },
    ]);
    expect(await events(TOPICS.purchasesAllocations)).toHaveLength(1);
    const lookup = await app.handle(
      new Request(`http://localhost/internal/payments/lookup?organizationId=${ORG}&id=${payment.id}`, {
        headers: { authorization: "Bearer svc:banking" },
      }),
    );
    expect(await lookup.json()).toEqual([
      expect.objectContaining({ id: payment.id, kind: "disbursement", amount: "2666000.00" }),
    ]);
  });

  test("voids a payment and reverses the allocations only after they were applied", async () => {
    const [payment] = await json<PaymentBody[]>(call("/?kind=receipt"));
    const voided = await json<PaymentBody>(
      call(`/${payment?.id}/void`, { method: "POST", body: { date: "2026-03-25" } }),
    );
    expect(voided.status).toBe("void");
    expect((await call(`/${payment?.id}/void`, { method: "POST" })).status).toBe(409);

    const applied: AllocationRequest[] = [];
    const reversed: string[] = [];
    let salesUp = false;
    const sales: Allocations = {
      apply: async (request) => {
        if (!salesUp) throw new Error("sales unreachable");
        applied.push(request);
        return { applied: request.allocations.length };
      },
      reverse: async (request) => {
        reversed.push(request.paymentId);
        return { reversed: 1 };
      },
    };
    const ledger: Ledger = { post: async () => ({ id: id(900) }), reverse: async () => ({ id: id(901) }) };
    const relay = createRelay({
      db: database.db,
      logger: createLogger({ name: "payments" }),
      handlers: paymentHandlers({ db: database.db, ledger, sales, purchases: sales }),
    });
    await relay.runOnce();
    expect(applied).toHaveLength(0);
    expect(reversed).toHaveLength(0);

    salesUp = true;
    await database.db.execute(sql`update outbox set available_at = now() where delivered_at is null`);
    await relay.runOnce();
    expect(applied.map((request) => request.paymentId)).toContain(payment?.id ?? "");
    expect(reversed).toEqual([payment?.id ?? ""]);
  });
});
