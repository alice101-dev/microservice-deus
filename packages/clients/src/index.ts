import type { Client } from "@deus/http";

const CHUNK = 200;

export type ServiceToken = () => Promise<string>;

export interface AccountRef {
  id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  parentId: string | null;
  active: boolean;
  postable: boolean;
}

export interface ContactRef {
  id: string;
  name: string;
  isCustomer: boolean;
  isVendor: boolean;
  email: string | null;
  taxId: string | null;
  address: string | null;
  paymentTermsDays: number;
  active: boolean;
}

export type Lookup<T> = (ids: string[], organizationId: string) => Promise<T[]>;

function lookup<T>(client: Client, path: string, serviceToken: ServiceToken): Lookup<T> {
  return async (ids, organizationId) => {
    const unique = [...new Set(ids)];
    const found: T[] = [];
    for (let start = 0; start < unique.length; start += CHUNK) {
      const id = unique.slice(start, start + CHUNK);
      found.push(...(await client.get<T[]>(path, { query: { organizationId, id }, token: await serviceToken() })));
    }
    return found;
  };
}

export const accountsLookup = (client: Client, serviceToken: ServiceToken) =>
  lookup<AccountRef>(client, "/internal/accounts/lookup", serviceToken);

export const contactsLookup = (client: Client, serviceToken: ServiceToken) =>
  lookup<ContactRef>(client, "/internal/contacts/lookup", serviceToken);
