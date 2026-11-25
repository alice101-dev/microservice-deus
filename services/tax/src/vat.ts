import type { BalanceRow, JournalRequest } from "@deus/clients";
import { fromCents, toCents } from "@deus/money";

export interface VatAccounts {
  output: string;
  input: string;
  payable: string;
}

export function periodEnd(period: string) {
  const [year, month] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function calculate(balances: readonly BalanceRow[], accounts: VatAccounts) {
  const net = (accountId: string) => {
    const row = balances.find((entry) => entry.accountId === accountId);
    return row ? toCents(row.debit) - toCents(row.credit) : 0n;
  };
  const output = -net(accounts.output);
  const input = net(accounts.input);
  const clamp = (value: bigint) => (value > 0n ? value : 0n);
  const outputVat = clamp(output);
  const inputVat = clamp(input);
  const payable = clamp(outputVat - inputVat);
  return {
    outputVat: fromCents(outputVat),
    inputVat: fromCents(inputVat),
    payable: fromCents(payable),
    carriedForward: fromCents(clamp(inputVat - outputVat)),
  };
}

export function settlementJournal(
  vatReturn: {
    id: string;
    organizationId: string;
    period: string;
    outputVat: string;
    inputVat: string;
    payable: string;
  },
  accounts: VatAccounts,
  filing: { createdBy: string; date: string },
): JournalRequest | null {
  const output = toCents(vatReturn.outputVat);
  if (output === 0n) return null;
  const offset = output - toCents(vatReturn.payable);
  const lines = [
    { accountId: accounts.output, debit: fromCents(output), memo: `PPN Keluaran ${vatReturn.period}` },
    ...(offset > 0n
      ? [{ accountId: accounts.input, credit: fromCents(offset), memo: `PPN Masukan ${vatReturn.period}` }]
      : []),
    ...(toCents(vatReturn.payable) > 0n
      ? [{ accountId: accounts.payable, credit: vatReturn.payable, memo: `PPN kurang bayar ${vatReturn.period}` }]
      : []),
  ];
  return {
    organizationId: vatReturn.organizationId,
    createdBy: filing.createdBy,
    date: filing.date,
    description: `SPT Masa PPN ${vatReturn.period}`,
    sourceId: vatReturn.id,
    lines,
  };
}
