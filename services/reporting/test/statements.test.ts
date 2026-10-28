import { describe, expect, test } from "bun:test";
import type { AccountRef, BalanceRow } from "@deus/clients";
import { balanceSheet, dayBefore, fiscalYearStart, incomeStatement, netIncome } from "../src/statements";

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
  account("kas", "1-1000", "Kas", "asset", "a"),
  account("ar", "1-1200", "Piutang Usaha", "asset", "a"),
  account("l", "2-0000", "Liabilitas", "liability"),
  account("ap", "2-1000", "Utang Usaha", "liability", "l"),
  account("vat", "2-1100", "PPN Keluaran", "liability", "l"),
  account("e", "3-0000", "Ekuitas", "equity"),
  account("cap", "3-1000", "Modal Disetor", "equity", "e"),
  account("r", "4-0000", "Pendapatan", "revenue"),
  account("sales", "4-1000", "Pendapatan Penjualan", "revenue", "r"),
  account("cogs", "5-0000", "Harga Pokok Penjualan", "expense"),
  account("buy", "5-1000", "Pembelian Barang Dagang", "expense", "cogs"),
  account("opex", "6-0000", "Beban Operasional", "expense"),
  account("rent", "6-2000", "Beban Sewa", "expense", "opex"),
];
const row = (accountId: string, debit: string, credit: string): BalanceRow => ({ accountId, debit, credit });

describe("financial statements", () => {
  const balances = [
    row("kas", "10000000.00", "2500000.00"),
    row("ar", "1110000.00", "0.00"),
    row("ap", "0.00", "1500000.00"),
    row("vat", "0.00", "110000.00"),
    row("cap", "0.00", "5000000.00"),
    row("sales", "0.00", "4000000.00"),
    row("buy", "1500000.00", "0.00"),
    row("rent", "2500000.00", "0.00"),
  ];

  test("builds an income statement grouped under the top-level accounts", () => {
    const statement = incomeStatement(CHART, balances, { from: "2026-01-01", to: "2026-03-31" });
    expect(statement.revenue.total).toBe("4000000.00");
    expect(statement.expense.groups.map((group) => [group.code, group.total])).toEqual([
      ["5-0000", "1500000.00"],
      ["6-0000", "2500000.00"],
    ]);
    expect(statement.netIncome).toBe("0.00");
    expect(netIncome(CHART, [row("sales", "0", "100"), row("rent", "30", "0")])).toBe(7000n);
  });

  test("balances the balance sheet with the earnings not closed into equity", () => {
    const sheet = balanceSheet(CHART, balances, { priorYears: 0n, currentYear: 0n }, "2026-03-31");
    expect(sheet.totalAssets).toBe("8610000.00");
    expect(sheet.balanced).toBe(false);
    const withEarnings = balanceSheet(
      CHART,
      [...balances, row("kas", "1000000.00", "0.00")],
      { priorYears: 1000000n * 100n, currentYear: 0n },
      "2026-03-31",
    );
    expect(withEarnings).toMatchObject({
      totalAssets: "9610000.00",
      totalLiabilitiesAndEquity: "7610000.00",
    });
    const balanced = balanceSheet(CHART, balances, { priorYears: 0n, currentYear: 2000000n * 100n }, "2026-03-31");
    expect(balanced.balanced).toBe(true);
    expect(balanced.equity.groups.at(-1)?.lines).toEqual([
      { accountId: null, code: null, name: "Laba tahun berjalan", amount: "2000000.00" },
    ]);
  });

  test("finds the start of the fiscal year", () => {
    expect(fiscalYearStart("2026-03-31", 1)).toBe("2026-01-01");
    expect(fiscalYearStart("2026-03-31", 4)).toBe("2025-04-01");
    expect(fiscalYearStart("2026-04-01", 4)).toBe("2026-04-01");
    expect(dayBefore("2026-01-01")).toBe("2025-12-31");
  });
});
