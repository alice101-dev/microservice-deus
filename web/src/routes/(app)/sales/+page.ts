import { api, call } from "#lib/api.ts";

const STATUSES = ["draft", "issued", "void"] as const;
type Status = (typeof STATUSES)[number];

export async function load({ url }) {
  const status = url.searchParams.get("status");
  const filter = STATUSES.includes(status as Status) ? (status as Status) : undefined;
  const invoices = await call(api.sales.invoices.get({ query: filter ? { status: filter } : {} }));
  return { invoices, status: filter ?? null };
}
