import { session } from "#lib/session.svelte.ts";

export const ssr = false;
export const prerender = false;

export async function load() {
  await session.ensure();
}
