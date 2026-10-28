import { api, call } from "#lib/api.ts";

export async function load({ parent }) {
  await parent();
  return { messages: await call(api.notification.messages.get({ query: {} })) };
}
