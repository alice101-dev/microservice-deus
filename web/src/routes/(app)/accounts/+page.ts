import { api, call } from "#lib/api.ts";

export async function load({ parent }) {
  await parent();
  return { accounts: await call(api.accounts.get()) };
}
