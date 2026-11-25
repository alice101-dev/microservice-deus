import { api, call } from "#lib/api.ts";

export async function load({ parent }) {
  await parent();
  const [bankAccounts, accounts] = await Promise.all([call(api.banking.accounts.get()), call(api.accounts.get())]);
  return { bankAccounts, accounts };
}
