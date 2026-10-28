import { error } from "@sveltejs/kit";
import { api, call } from "#lib/api.ts";
import { today } from "#lib/format.ts";

export async function load({ params, url }) {
  const asOf = url.searchParams.get("asOf") ?? today();
  const [bankAccounts, lines, reconciliation, accounts, payments] = await Promise.all([
    call(api.banking.accounts.get()),
    call(api.banking.accounts({ id: params.id }).lines.get({ query: {} })),
    call(api.banking.accounts({ id: params.id }).reconciliation.get({ query: { asOf } })),
    call(api.accounts.get()),
    call(api.payments.get({ query: {} })),
  ]);
  const bank = bankAccounts.find((account) => account.id === params.id);
  if (!bank) error(404, "Rekening tidak ditemukan");
  return {
    asOf,
    bank,
    lines,
    reconciliation,
    accounts: accounts.filter((account) => account.postable && account.active && account.id !== bank.ledgerAccountId),
    payments: payments.filter(
      (payment) => payment.status === "recorded" && payment.cashAccountId === bank.ledgerAccountId,
    ),
  };
}
