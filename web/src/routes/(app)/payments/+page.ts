import { api, call } from "#lib/api.ts";

export async function load({ url }) {
  const kind = url.searchParams.get("kind");
  const filter = kind === "receipt" || kind === "disbursement" ? kind : undefined;
  const payments = await call(api.payments.get({ query: filter ? { kind: filter } : {} }));
  return { payments, kind: filter ?? null };
}
