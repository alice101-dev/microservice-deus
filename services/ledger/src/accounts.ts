import type { Client } from "@deus/http";
import type { AccountRef, AccountsLookup } from "./app";

const CHUNK = 200;

export function accountsLookup(client: Client, serviceToken: () => Promise<string>): AccountsLookup {
  return async (ids, organizationId) => {
    const found: AccountRef[] = [];
    for (let start = 0; start < ids.length; start += CHUNK) {
      const id = ids.slice(start, start + CHUNK);
      found.push(
        ...(await client.get<AccountRef[]>("/internal/accounts/lookup", {
          query: { organizationId, id },
          token: await serviceToken(),
        })),
      );
    }
    return found;
  };
}
