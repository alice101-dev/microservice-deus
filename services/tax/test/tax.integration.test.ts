import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Verifier } from "@deus/auth";
import type { AccountRef, BalanceRow, JournalRequest } from "@deus/clients";
import { loadConfig } from "@deus/config";
import { createTestDatabase } from "@deus/db/testing";
import { createLogger } from "@deus/logger";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { createApp } from "../src/app";
import { outbox, schema } from "../src/schema";

const url = process.env.DATABASE_TEST_URL;
const { telemetry } = startTestTelemetry("tax");
afterAll(() => telemetry.shutdown());

const ORG = "00000000-0000-4000-8000-00000000000a";
const USER = "00000000-0000-4000-8000-000000000001";
const account = (id: string, code: string, type: AccountRef["type"]): AccountRef => ({
  id,
  code,
  name: code,
  type,
  parentId: null,
  active: true,
  postable: true,
});
const ACCOUNTS = [
  account("out", "2-1100", "liability"),
  account("in", "1-1400", "asset"),
  account("pay", "2-1200", "liability"),
];
let ledger: BalanceRow[] = [
  { accountId: "out", debit: "0.00", credit: "1100000.00" },
  { accountId: "in", debit: "330000.00", credit: "0.00" },
];
let date = "2026-03-20";
const verify: Verifier = async (token) => ({ userId: USER, email: "user@example.com", organizationId: token, token });

describe.skipIf(!url)("tax against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase<typeof schema>>>;
  let app: ReturnType<typeof createApp>;
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    app.handle(
      new Request(`http://localhost/api/tax${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${ORG}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
    );
  const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;

  beforeAll(async () => {
    database = await createTestDatabase({
      url: url ?? "",
      service: "tax",
      serviceDirectory: join(import.meta.dir, ".."),
      schema,
    });
    app = createApp({
      config: loadConfig({}, { SERVICE_NAME: "tax" }),
      logger: createLogger({ name: "tax" }),
      db: database.db,
      verify,
      accountsByCode: async (codes) => ACCOUNTS.filter((entry) => codes.includes(entry.code)),
      balances: async (_organizationId, range) => {
        expect(range.to).toBe("2026-03-31");
        return ledger;
      },
      vatOutputAccountCode: "2-1100",
      vatInputAccountCode: "1-1400",
      taxPayableAccountCode: "2-1200",
      today: () => date,
    });
  });
  afterAll(() => database.cleanup());

  test("calculates and recalculates the draft return of a month", async () => {
    const created = await call("/vat-returns", { method: "POST", body: { period: "2026-03" } });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      status: "draft",
      outputVat: "1100000.00",
      inputVat: "330000.00",
      payable: "770000.00",
      carriedForward: "0.00",
    });
    ledger = [
      { accountId: "out", debit: "0.00", credit: "1100000.00" },
      { accountId: "in", debit: "440000.00", credit: "0.00" },
    ];
    const again = await call("/vat-returns", { method: "POST", body: { period: "2026-03" } });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { payable: string }).payable).toBe("660000.00");
    expect((await call("/vat-returns", { method: "POST", body: { period: "2026-13" } })).status).toBe(400);
  });

  test("files only after the month ends and posts the settlement once", async () => {
    expect((await call("/vat-returns/2026-03/file", { method: "POST" })).status).toBe(422);
    date = "2026-04-10";
    const filed = await json<{ status: string; payable: string }>(
      call("/vat-returns/2026-03/file", { method: "POST" }),
    );
    expect(filed).toMatchObject({ status: "filed", payable: "660000.00" });
    expect((await call("/vat-returns/2026-03/file", { method: "POST" })).status).toBe(409);
    expect((await call("/vat-returns", { method: "POST", body: { period: "2026-03" } })).status).toBe(409);
    const [event] = await database.db.select().from(outbox);
    const journal = event?.payload as JournalRequest;
    expect(journal).toMatchObject({ date: "2026-04-10", description: "SPT Masa PPN 2026-03" });
    expect(journal.lines).toEqual([
      { accountId: "out", debit: "1100000.00", memo: "PPN Keluaran 2026-03" },
      { accountId: "in", credit: "440000.00", memo: "PPN Masukan 2026-03" },
      { accountId: "pay", credit: "660000.00", memo: "PPN kurang bayar 2026-03" },
    ]);
    expect((await json<Array<{ period: string }>>(call("/vat-returns"))).map((row) => row.period)).toEqual(["2026-03"]);
  });
});
