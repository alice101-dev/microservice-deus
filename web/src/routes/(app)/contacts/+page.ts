import { api, call } from "#lib/api.ts";

export async function load({ url, parent }) {
  await parent();
  const role = url.searchParams.get("role");
  const contacts = await call(api.contacts.get({ query: role === "customer" || role === "vendor" ? { role } : {} }));
  return { contacts, role };
}
