import { redirect } from "@sveltejs/kit";
import { session } from "#lib/session.svelte.ts";

export async function load({ url }) {
  await session.ensure();
  if (!session.user) redirect(307, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  if (!session.activeOrganizationId) redirect(307, "/onboarding");
}
