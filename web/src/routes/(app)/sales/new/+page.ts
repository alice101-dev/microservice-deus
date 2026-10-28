import { api, call } from "#lib/api.ts";

export async function load() {
  const [customers, products, accounts] = await Promise.all([
    call(api.contacts.get({ query: { role: "customer", active: true } })),
    call(api.products.get({ query: { active: true } })),
    call(api.accounts.get()),
  ]);
  return {
    customers,
    products,
    accounts: accounts.filter((account) => account.type === "revenue" && account.postable && account.active),
  };
}
