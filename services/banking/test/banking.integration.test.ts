import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Verifier } from "@deus/auth";
import type { AccountRef, BalanceRow, JournalRequest, PaymentRef } from "@deus/clients";
import { loadConfig } from "@deus/config";
import { createTestDatabase } from "@deus/db/testing";
import { createLogger } from "@deus/logger";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { createApp } from "../src/app";
import { outbox, schema } from "../src/schema";

const url = process.env.DATABASE_TEST_URL;
const { telemetry } = startTestTelemetry("banking");
afterAll(() => telemetry.shutdown());

const ORG = "00000000-0000-4000-8000-00000000000a";
const USER = "00000000-0000-4000-8000-000000000001";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BANK = id(111);
const CASH = id(110);
const FEES = id(690);
const HEADER = id(100);
const RECEIPT = id(801);
const DISBURSEMENT = id(802);
const OTHER_ACCOUNT_RECEIPT = id(803);

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
  account(BANK, "1-1100", "asset"),
  account(CASH, "1-1000", "asset"),
  account(FEES, "6-9000", "expense"),
  account(HEADER, "1-0000", "asset", false),
];
const payment = (paymentId: string, kind: PaymentRef["kind"], amount: string, cashAccountId = BANK): PaymentRef => ({
  id: paymentId,
  number: kind === "receipt" ? "RCV/2026/0001" : "PAY/2026/0001",
  kind,
  status: "recorded",
  contactId: id(201),
  contactName: "PT Pelanggan Setia",
  date: "2026-03-20",
  cashAccountId,
  amount,
  reference: null,
});
const PAYMENTS = [
  payment(RECEIPT, "receipt", "383050.00"),
  payment(DISBURSEMENT, "disbursement", "2666000.00"),
  payment(OTHER_ACCOUNT_RECEIPT, "receipt", "100.00", CASH),
];
let ledgerBank: BalanceRow = { accountId: BANK, debit: "10383050.00", credit: "2666000.00" };
const verify: Verifier = async (token) => ({ userId: USER, email: "user@example.com", organizationId: token, token });
const byIds =
  <T extends { id: string }>(rows: T[]) =>
  async (ids: string[]) =>
    rows.filter((row) => ids.includes(row.id));

interface LineBody {
  id: string;
  amount: string;
  status: string;
  description: string;
}

describe.skipIf(!url)("banking against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase<typeof schema>>>;
  let app: ReturnType<typeof createApp>;
  let bankId = "";
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    app.handle(
      new Request(`http://localhost/api/banking${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${ORG}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
    );
  const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;
  const statement = [
    { date: "2026-03-20", description: "TRF MASUK PT PELANGGAN SETIA", amount: "383050", reference: "TRF-1" },
    { date: "2026-03-25", description: "TRF KELUAR CV PEMASOK", amount: "-2666000" },
    { date: "2026-03-31", description: "BIAYA ADM", amount: "-15000" },
    { date: "2026-03-31", description: "BIAYA ADM", amount: "-15000" },
  ];

  beforeAll(async () => {
    database = await createTestDatabase({
      url: url ?? "",
      service: "banking",
      serviceDirectory: join(import.meta.dir, ".."),
      schema,
    });
    app = createApp({
      config: loadConfig({}, { SERVICE_NAME: "banking" }),
      logger: createLogger({ name: "banking" }),
      db: database.db,
      verify,
      accounts: byIds(ACCOUNTS),
      payments: byIds(PAYMENTS),
      balances: async () => [ledgerBank],
    });
  });
  afterAll(() => database.cleanup());

  test("links a bank account to a postable asset account once", async () => {
    const body = {
      name: "BCA Operasional",
      bankName: "BCA",
      accountNumber: "123-456-7890",
      ledgerAccountId: BANK,
      openingBalance: "10000000",
      openingDate: "2026-03-01",
    };
    const created = await call("/accounts", { method: "POST", body });
    expect(created.status).toBe(201);
    bankId = (await json<{ id: string }>(created)).id;
    expect((await call("/accounts", { method: "POST", body })).status).toBe(409);
    expect((await call("/accounts", { method: "POST", body: { ...body, ledgerAccountId: FEES } })).status).toBe(422);
    expect((await call("/accounts", { method: "POST", body: { ...body, ledgerAccountId: HEADER } })).status).toBe(422);
  });

  test("imports a statement and skips lines imported before, keeping real repeats", async () => {
    expect(await json(call(`/accounts/${bankId}/statements`, { method: "POST", body: { lines: statement } }))).toEqual({
      imported: 4,
      duplicates: 0,
    });
    const overlap = [...statement, { date: "2026-04-01", description: "BUNGA", amount: "1250.50" }];
    expect(await json(call(`/accounts/${bankId}/statements`, { method: "POST", body: { lines: overlap } }))).toEqual({
      imported: 1,
      duplicates: 4,
    });
    expect(
      (
        await call(`/accounts/${bankId}/statements`, {
          method: "POST",
          body: { lines: [{ date: "2026-02-28", description: "x", amount: "1" }] },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call(`/accounts/${bankId}/statements`, {
          method: "POST",
          body: { lines: [{ date: "2026-03-02", description: "x", amount: "0" }] },
        })
      ).status,
    ).toBe(422);
  });

  test("matches lines to payments of the same account, amount and direction", async () => {
    const lines = await json<LineBody[]>(call(`/accounts/${bankId}/lines`));
    const incoming = lines.find((line) => line.amount === "383050.00");
    const outgoing = lines.find((line) => line.amount === "-2666000.00");
    expect(
      (await call(`/lines/${incoming?.id}/match`, { method: "POST", body: { paymentId: DISBURSEMENT } })).status,
    ).toBe(422);
    expect(
      (await call(`/lines/${incoming?.id}/match`, { method: "POST", body: { paymentId: OTHER_ACCOUNT_RECEIPT } }))
        .status,
    ).toBe(422);
    const matched = await json<LineBody>(
      call(`/lines/${incoming?.id}/match`, { method: "POST", body: { paymentId: RECEIPT } }),
    );
    expect(matched.status).toBe("matched");
    expect((await call(`/lines/${incoming?.id}/match`, { method: "POST", body: { paymentId: RECEIPT } })).status).toBe(
      409,
    );
    expect(
      (await call(`/lines/${outgoing?.id}/match`, { method: "POST", body: { paymentId: DISBURSEMENT } })).status,
    ).toBe(200);
  });

  test("posts bank fees through the outbox and reconciles against the ledger", async () => {
    const fees = (await json<LineBody[]>(call(`/accounts/${bankId}/lines?status=unmatched`))).filter(
      (line) => line.description === "BIAYA ADM",
    );
    expect(fees).toHaveLength(2);
    for (const fee of fees) {
      expect((await call(`/lines/${fee.id}/post`, { method: "POST", body: { accountId: FEES } })).status).toBe(200);
    }
    expect((await call(`/lines/${fees[0]?.id}/post`, { method: "POST", body: { accountId: FEES } })).status).toBe(409);
    const journals = (await database.db.select().from(outbox)).map((event) => event.payload as JournalRequest);
    expect(journals).toHaveLength(2);
    expect(journals[0]?.lines).toEqual([
      { accountId: FEES, debit: "15000.00", memo: "BIAYA ADM" },
      { accountId: BANK, credit: "15000.00", memo: "BIAYA ADM" },
    ]);

    const before = await json<{
      statementBalance: string;
      ledgerBalance: string;
      difference: string;
      reconciled: boolean;
    }>(call(`/accounts/${bankId}/reconciliation?asOf=2026-03-31`));
    expect(before).toMatchObject({
      statementBalance: "7687050.00",
      ledgerBalance: "7717050.00",
      difference: "-30000.00",
      reconciled: false,
    });
    ledgerBank = { accountId: BANK, debit: "10383050.00", credit: "2696000.00" };
    const after = await json<{ reconciled: boolean; unmatched: unknown[] }>(
      call(`/accounts/${bankId}/reconciliation?asOf=2026-03-31`),
    );
    expect(after).toMatchObject({ reconciled: true, unmatched: [] });
    const april = await json<{ reconciled: boolean; unmatched: LineBody[] }>(
      call(`/accounts/${bankId}/reconciliation?asOf=2026-04-30`),
    );
    expect(april.unmatched.map((line) => line.description)).toEqual(["BUNGA"]);
  });
});
