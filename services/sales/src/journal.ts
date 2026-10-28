import type { JournalRequest } from "@deus/clients";
import { fromCents, toCents } from "@deus/money";
import type { Invoice, InvoiceLine } from "./schema";

export interface SalesAccounts {
  receivable: string;
  vatOutput: string;
}

export function invoiceJournal(
  invoice: Invoice,
  lines: readonly InvoiceLine[],
  accounts: SalesAccounts,
): JournalRequest {
  const revenue = new Map<string, bigint>();
  for (const line of lines) {
    revenue.set(line.revenueAccountId, (revenue.get(line.revenueAccountId) ?? 0n) + toCents(line.amount));
  }
  const credits = [...revenue.entries()]
    .filter(([, cents]) => cents > 0n)
    .map(([accountId, cents]) => ({ accountId, credit: fromCents(cents), memo: "Pendapatan" }));
  if (toCents(invoice.vatTotal) > 0n) {
    credits.push({ accountId: accounts.vatOutput, credit: invoice.vatTotal, memo: "PPN Keluaran" });
  }
  return {
    organizationId: invoice.organizationId,
    createdBy: invoice.createdBy,
    date: invoice.issueDate,
    description: `Invoice ${invoice.number} - ${invoice.contactName}`,
    sourceId: invoice.id,
    lines: [{ accountId: accounts.receivable, debit: invoice.total, memo: `Piutang ${invoice.number}` }, ...credits],
  };
}
