import { api, call } from "#lib/api.ts";

export async function load() {
  const [vendors, products, accounts] = await Promise.all([
    call(api.contacts.get({ query: { role: "vendor", active: true } })),
    call(api.products.get({ query: { active: true } })),
    call(api.accounts.get()),
  ]);
  return {
    vendors,
    products,
    accounts: accounts.filter(
      (account) => (account.type === "expense" || account.type === "asset") && account.postable && account.active,
    ),
  };
}
