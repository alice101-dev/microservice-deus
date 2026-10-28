import type { Client } from "@deus/http";
import type { AccountRef, AccountsLookup } from "./app";

const CHUNK = 200;

export function accountsLookup(client: Client): AccountsLookup {
  return async (ids, token) => {
    const found: AccountRef[] = [];
    for (let start = 0; start < ids.length; start += CHUNK) {
      const id = ids.slice(start, start + CHUNK);
      found.push(...(await client.get<AccountRef[]>("/api/accounts/lookup", { query: { id }, token })));
    }
    return found;
  };
}
