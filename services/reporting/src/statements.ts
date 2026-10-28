import type { AccountRef, BalanceRow } from "@deus/clients";
import { fromCents, toCents } from "@deus/money";

export interface StatementLine {
  accountId: string | null;
  code: string | null;
  name: string;
  amount: string;
}

export interface StatementGroup {
  code: string;
  name: string;
  lines: StatementLine[];
  total: string;
}

export interface StatementSection {
  type: AccountRef["type"];
  groups: StatementGroup[];
  total: string;
}

const CREDIT_NORMAL = new Set<AccountRef["type"]>(["liability", "equity", "revenue"]);

function rootOf(account: AccountRef, byId: ReadonlyMap<string, AccountRef>) {
  let current = account;
  const seen = new Set<string>();
  while (current.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
    seen.add(current.id);
    current = byId.get(current.parentId) as AccountRef;
  }
  return current;
}

export function signed(type: AccountRef["type"], row: Pick<BalanceRow, "debit" | "credit">) {
  const net = toCents(row.debit) - toCents(row.credit);
  return CREDIT_NORMAL.has(type) ? -net : net;
}

export function section(
  type: AccountRef["type"],
  chart: readonly AccountRef[],
  balances: readonly BalanceRow[],
  extra: ReadonlyArray<{ name: string; cents: bigint }> = [],
): { section: StatementSection; cents: bigint } {
  const byId = new Map(chart.map((account) => [account.id, account]));
  const groups = new Map<string, { root: AccountRef; lines: Array<StatementLine & { cents: bigint }> }>();
  for (const row of balances) {
    const account = byId.get(row.accountId);
    if (!account || account.type !== type) continue;
    const cents = signed(type, row);
    if (cents === 0n) continue;
    const root = rootOf(account, byId);
    const group = groups.get(root.id) ?? { root, lines: [] };
    group.lines.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      amount: fromCents(cents),
      cents,
    });
    groups.set(root.id, group);
  }
  const ordered = [...groups.values()].sort((a, b) => a.root.code.localeCompare(b.root.code));
  const result: StatementGroup[] = ordered.map(({ root, lines }) => {
    const sorted = lines.sort((a, b) => (a.code ?? "").localeCompare(b.code ?? ""));
    return {
      code: root.code,
      name: root.name,
      lines: sorted.map(({ cents: _cents, ...line }) => line),
      total: fromCents(sorted.reduce((total, line) => total + line.cents, 0n)),
    };
  });
  const additions = extra.filter((entry) => entry.cents !== 0n);
  if (additions.length > 0) {
    result.push({
      code: "",
      name: "Laba (rugi) yang belum ditutup",
      lines: additions.map((entry) => ({
        accountId: null,
        code: null,
        name: entry.name,
        amount: fromCents(entry.cents),
      })),
      total: fromCents(additions.reduce((total, entry) => total + entry.cents, 0n)),
    });
  }
  const cents = result.reduce((total, group) => total + toCents(group.total), 0n);
  return { section: { type, groups: result, total: fromCents(cents) }, cents };
}

export function netIncome(chart: readonly AccountRef[], balances: readonly BalanceRow[]) {
  return section("revenue", chart, balances).cents - section("expense", chart, balances).cents;
}

export function incomeStatement(
  chart: readonly AccountRef[],
  balances: readonly BalanceRow[],
  period: { from: string; to: string },
) {
  const revenue = section("revenue", chart, balances);
  const expense = section("expense", chart, balances);
  return {
    kind: "income-statement" as const,
    from: period.from,
    to: period.to,
    revenue: revenue.section,
    expense: expense.section,
    netIncome: fromCents(revenue.cents - expense.cents),
  };
}

export function fiscalYearStart(asOf: string, startMonth: number) {
  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7));
  const startYear = month >= startMonth ? year : year - 1;
  return `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
}

export function dayBefore(isoDate: string) {
  const value = new Date(`${isoDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export function balanceSheet(
  chart: readonly AccountRef[],
  balances: readonly BalanceRow[],
  earnings: { priorYears: bigint; currentYear: bigint },
  asOf: string,
) {
  const assets = section("asset", chart, balances);
  const liabilities = section("liability", chart, balances);
  const equity = section("equity", chart, balances, [
    { name: "Laba tahun-tahun lalu", cents: earnings.priorYears },
    { name: "Laba tahun berjalan", cents: earnings.currentYear },
  ]);
  const liabilitiesAndEquity = liabilities.cents + equity.cents;
  return {
    kind: "balance-sheet" as const,
    asOf,
    assets: assets.section,
    liabilities: liabilities.section,
    equity: equity.section,
    totalAssets: fromCents(assets.cents),
    totalLiabilitiesAndEquity: fromCents(liabilitiesAndEquity),
    balanced: assets.cents === liabilitiesAndEquity,
  };
}
