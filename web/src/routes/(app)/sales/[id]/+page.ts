import { api, call } from "#lib/api.ts";

export async function load({ params }) {
  const [invoice, accounts] = await Promise.all([
    call(api.sales.invoices({ id: params.id }).get()),
    call(api.accounts.get()),
  ]);
  return { invoice, accounts };
}
