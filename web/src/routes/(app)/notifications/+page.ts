import { api, call } from "#lib/api.ts";

export async function load() {
  return { messages: await call(api.notification.messages.get({ query: {} })) };
}
