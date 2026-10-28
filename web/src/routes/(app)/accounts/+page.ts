import { api, call } from "#lib/api.ts";

export async function load() {
  return { accounts: await call(api.accounts.get()) };
}
