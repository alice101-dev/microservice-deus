import { api, call } from "#lib/api.ts";

export async function load() {
  const [products, accounts] = await Promise.all([call(api.products.get({ query: {} })), call(api.accounts.get())]);
  return { products, accounts };
}
