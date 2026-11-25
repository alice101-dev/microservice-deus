import { api, call } from "#lib/api.ts";

const STATUSES = ["draft", "approved", "void"] as const;
type Status = (typeof STATUSES)[number];

export async function load({ url, parent }) {
  await parent();
  const status = url.searchParams.get("status");
  const filter = STATUSES.includes(status as Status) ? (status as Status) : undefined;
  const bills = await call(api.purchases.bills.get({ query: filter ? { status: filter } : {} }));
  return { bills, status: filter ?? null };
}
