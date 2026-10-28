import { api, call } from "#lib/api.ts";

export async function load({ url, parent }) {
  await parent();
  const kind: "receipt" | "disbursement" = url.searchParams.get("kind") === "disbursement" ? "disbursement" : "receipt";
  const document = url.searchParams.get("document");
  const [contacts, accounts, invoices, bills] = await Promise.all([
    call(api.contacts.get({ query: { role: kind === "receipt" ? "customer" : "vendor", active: true } })),
    call(api.accounts.get()),
    kind === "receipt" ? call(api.sales.invoices.get({ query: { status: "issued" } })) : Promise.resolve([]),
    kind === "disbursement" ? call(api.purchases.bills.get({ query: { status: "approved" } })) : Promise.resolve([]),
  ]);
  const documents = [
    ...invoices.map((invoice) => ({ ...invoice, date: invoice.issueDate })),
    ...bills.map((bill) => ({ ...bill, date: bill.billDate })),
  ]
    .filter((entry) => entry.amountDue !== "0.00")
    .map((entry) => ({
      id: entry.id,
      number: entry.number ?? "",
      contactId: entry.contactId,
      date: entry.date,
      dueDate: entry.dueDate,
      amountDue: entry.amountDue,
    }));
  return {
    kind,
    document,
    contacts,
    documents,
    cashAccounts: accounts.filter(
      (account) => account.type === "asset" && account.postable && account.active && /^1-1[01]/.test(account.code),
    ),
  };
}
