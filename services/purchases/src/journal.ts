import type { JournalRequest } from "@deus/clients";
import { totalsByAccount } from "@deus/documents";
import { toCents } from "@deus/money";
import type { Bill, BillLine } from "./schema";

export interface PurchaseAccounts {
  payable: string;
  vatInput: string;
}

export function billJournal(bill: Bill, lines: readonly BillLine[], accounts: PurchaseAccounts): JournalRequest {
  const debits = totalsByAccount(lines).map(({ accountId, amount }) => ({
    accountId,
    debit: amount,
    memo: "Pembelian",
  }));
  if (toCents(bill.vatTotal) > 0n) {
    debits.push({ accountId: accounts.vatInput, debit: bill.vatTotal, memo: "PPN Masukan" });
  }
  const reference = bill.vendorReference ? ` (${bill.vendorReference})` : "";
  return {
    organizationId: bill.organizationId,
    createdBy: bill.createdBy,
    date: bill.billDate,
    description: `Bill ${bill.number}${reference} - ${bill.contactName}`,
    sourceId: bill.id,
    lines: [...debits, { accountId: accounts.payable, credit: bill.total, memo: `Utang ${bill.number}` }],
  };
}
