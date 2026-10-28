import { api, call } from "#lib/api.ts";

export async function load({ params, parent }) {
  await parent();
  const [bill, accounts] = await Promise.all([
    call(api.purchases.bills({ id: params.id }).get()),
    call(api.accounts.get()),
  ]);
  return { bill, accounts };
}
