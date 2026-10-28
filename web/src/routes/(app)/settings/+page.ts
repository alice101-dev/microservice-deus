import { api } from "#lib/api.ts";

export async function load({ parent }) {
  await parent();
  const { data } = await api.organization.profile.get();
  return { profile: data && "legalName" in data ? data : null };
}
