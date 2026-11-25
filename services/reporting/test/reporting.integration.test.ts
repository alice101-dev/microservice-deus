import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Verifier } from "@deus/auth";
import type { AccountRef, BalanceRow, ProfileRef } from "@deus/clients";
import { loadConfig } from "@deus/config";
import { createTestDatabase } from "@deus/db/testing";
import { createLogger } from "@deus/logger";
import { fromCents, toCents } from "@deus/money";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { createApp } from "../src/app";
import { schema } from "../src/schema";

const url = process.env.DATABASE_TEST_URL;
const { telemetry } = startTestTelemetry("reporting");
afterAll(() => telemetry.shutdown());

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const account = (
  id: string,
  code: string,
  name: string,
  type: AccountRef["type"],
  parentId: string | null = null,
): AccountRef => ({
  id,
  code,
  name,
  type,
  parentId,
  active: true,
  postable: parentId !== null,
});
const CHART = [
  account("a", "1-0000", "Aset", "asset"),
  account("bank", "1-1100", "Bank", "asset", "a"),
  account("ar", "1-1200", "Piutang Usaha", "asset", "a"),
  account("l", "2-0000", "Liabilitas", "liability"),
  account("vat", "2-1100", "PPN Keluaran", "liability", "l"),
  account("e", "3-0000", "Ekuitas", "equity"),
  account("cap", "3-1000", "Modal Disetor", "equity", "e"),
  account("r", "4-0000", "Pendapatan", "revenue"),
  account("sales", "4-1000", "Pendapatan Penjualan", "revenue", "r"),
  account("x", "6-0000", "Beban Operasional", "expense"),
  account("rent", "6-2000", "Beban Sewa", "expense", "x"),
];
const JOURNALS: Array<{ date: string; lines: Array<[string, string, string]> }> = [
  {
    date: "2025-01-02",
    lines: [
      ["bank", "10000000", "0"],
      ["cap", "0", "10000000"],
    ],
  },
  {
    date: "2025-06-10",
    lines: [
      ["ar", "2220000", "0"],
      ["sales", "0", "2000000"],
      ["vat", "0", "220000"],
    ],
  },
  {
    date: "2025-08-01",
    lines: [
      ["rent", "500000", "0"],
      ["bank", "0", "500000"],
    ],
  },
  {
    date: "2026-02-15",
    lines: [
      ["ar", "1110000", "0"],
      ["sales", "0", "1000000"],
      ["vat", "0", "110000"],
    ],
  },
  {
    date: "2026-03-01",
    lines: [
      ["bank", "2220000", "0"],
      ["ar", "0", "2220000"],
    ],
  },
  {
    date: "2026-03-05",
    lines: [
      ["rent", "750000", "0"],
      ["bank", "0", "750000"],
    ],
  },
];
const balances = async (_organizationId: string, range: { from?: string; to: string }): Promise<BalanceRow[]> => {
  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  for (const journal of JOURNALS) {
    if (journal.date > range.to || (range.from && journal.date < range.from)) continue;
    for (const [accountId, debit, credit] of journal.lines) {
      const total = totals.get(accountId) ?? { debit: 0n, credit: 0n };
      total.debit += toCents(debit);
      total.credit += toCents(credit);
      totals.set(accountId, total);
    }
  }
  return [...totals.entries()].map(([accountId, total]) => ({
    accountId,
    debit: fromCents(total.debit),
    credit: fromCents(total.credit),
  }));
};
const profile: ProfileRef = {
  organizationId: ORG_A,
  legalName: "PT Maju Bersama",
  taxId: null,
  address: null,
  currency: "IDR",
  fiscalYearStartMonth: 1,
};
const verify: Verifier = async (token) => ({
  userId: "00000000-0000-4000-8000-000000000001",
  email: "user@example.com",
  organizationId: token,
  token,
});

describe.skipIf(!url)("reporting against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase<typeof schema>>>;
  let app: ReturnType<typeof createApp>;
  const call = (path: string, token = ORG_A, init: { method?: string; body?: unknown } = {}) =>
    app.handle(
      new Request(`http://localhost/api/reporting${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
    );
  const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;

  beforeAll(async () => {
    database = await createTestDatabase({
      url: url ?? "",
      service: "reporting",
      serviceDirectory: join(import.meta.dir, ".."),
      schema,
    });
    app = createApp({
      config: loadConfig({}, { SERVICE_NAME: "reporting" }),
      logger: createLogger({ name: "reporting" }),
      db: database.db,
      verify,
      chart: async () => CHART,
      balances,
      profile: async (organizationId) => (organizationId === ORG_A ? profile : null),
    });
  });
  afterAll(() => database.cleanup());

  test("reports the income statement of a period", async () => {
    const statement = await json<{ revenue: { total: string }; expense: { total: string }; netIncome: string }>(
      call("/income-statement?from=2026-01-01&to=2026-03-31"),
    );
    expect(statement).toMatchObject({
      revenue: { total: "1000000.00" },
      expense: { total: "750000.00" },
      netIncome: "250000.00",
    });
    expect((await call("/income-statement?from=2026-04-01&to=2026-03-31")).status).toBe(422);
  });

  test("balances the balance sheet with prior-year and current-year earnings", async () => {
    const sheet = await json<{
      totalAssets: string;
      totalLiabilitiesAndEquity: string;
      balanced: boolean;
      equity: {
        groups: Array<{
          name: string;
          lines: Array<{ accountId: string | null; code: string | null; name: string; amount: string }>;
        }>;
      };
    }>(call("/balance-sheet?asOf=2026-03-31"));
    expect(sheet).toMatchObject({
      totalAssets: "12080000.00",
      totalLiabilitiesAndEquity: "12080000.00",
      balanced: true,
    });
    expect(sheet.equity.groups.at(-1)?.lines).toEqual([
      { accountId: null, code: null, name: "Laba tahun-tahun lalu", amount: "1500000.00" },
      { accountId: null, code: null, name: "Laba tahun berjalan", amount: "250000.00" },
    ]);
  });

  test("keeps statement snapshots per organization", async () => {
    const created = await call("/statements", ORG_A, {
      method: "POST",
      body: { kind: "income-statement", from: "2026-01-01", to: "2026-03-31" },
    });
    expect(created.status).toBe(201);
    const snapshot = await json<{ id: string; data: { netIncome: string } }>(created);
    expect(snapshot.data.netIncome).toBe("250000.00");
    await call("/statements", ORG_A, { method: "POST", body: { kind: "balance-sheet", to: "2026-03-31" } });
    const list = await json<Array<{ kind: string }>>(call("/statements"));
    expect(list.map((row) => row.kind).sort()).toEqual(["balance-sheet", "income-statement"]);
    expect((await json<Array<unknown>>(call("/statements?kind=balance-sheet"))).length).toBe(1);
    expect((await call(`/statements/${snapshot.id}`, ORG_B)).status).toBe(404);
    expect(await json<unknown[]>(call("/statements", ORG_B))).toEqual([]);
  });
});
