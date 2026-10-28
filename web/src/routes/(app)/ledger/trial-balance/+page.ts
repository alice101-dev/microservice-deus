import { api, call } from "#lib/api.ts";
import { today } from "#lib/format.ts";

export async function load({ url, parent }) {
  await parent();
  const asOf = url.searchParams.get("asOf") ?? today();
  return { asOf, report: await call(api.ledger["trial-balance"].get({ query: { asOf } })) };
}
