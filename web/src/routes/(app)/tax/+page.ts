import { api, call } from "#lib/api.ts";

export async function load({ parent }) {
  await parent();
  return { returns: await call(api.tax["vat-returns"].get()) };
}
