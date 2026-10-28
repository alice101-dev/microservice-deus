import { api, call } from "#lib/api.ts";

export async function load({ url, parent }) {
  await parent();
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  const [journals, accounts] = await Promise.all([
    call(api.ledger.journals.get({ query: { ...(from ? { from } : {}), ...(to ? { to } : {}) } })),
    call(api.accounts.get()),
  ]);
  return { journals, accounts, from: from ?? "", to: to ?? "" };
}
