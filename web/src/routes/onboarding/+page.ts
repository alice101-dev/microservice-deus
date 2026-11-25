import { redirect } from "@sveltejs/kit";
import { session } from "#lib/session.svelte.ts";

export async function load() {
  await session.ensure();
  if (!session.user) redirect(307, "/login");
}
