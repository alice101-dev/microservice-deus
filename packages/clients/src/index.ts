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

export interface ProductRef {
  id: string;
  sku: string;
  name: string;
  kind: "goods" | "service";
  unit: string;
  salePrice: string | null;
  purchasePrice: string | null;
  vatRate: string;
  revenueAccountId: string | null;
  expenseAccountId: string | null;
  active: boolean;
}

export const productsLookup = (client: Client, serviceToken: ServiceToken) =>
  lookup<ProductRef>(client, "/internal/products/lookup", serviceToken);

export type AccountsByCode = (codes: string[], organizationId: string) => Promise<AccountRef[]>;

export const accountsByCode =
  (client: Client, serviceToken: ServiceToken): AccountsByCode =>
  async (codes, organizationId) =>
    client.get<AccountRef[]>("/internal/accounts/by-code", {
      query: { organizationId, code: [...new Set(codes)] },
      token: await serviceToken(),
    });

export interface JournalLineInput {
  accountId: string;
  debit?: string;
  credit?: string;
  memo?: string;
}

export interface JournalRequest {
  organizationId: string;
  createdBy: string;
  date: string;
  description: string;
  sourceId: string;
  lines: JournalLineInput[];
}

export interface ReversalRequest {
  organizationId: string;
  createdBy: string;
  sourceId: string;
  date?: string;
  description?: string;
}

export interface Ledger {
  post(journal: JournalRequest, idempotencyKey: string): Promise<{ id: string }>;
  reverse(reversal: ReversalRequest): Promise<{ id: string }>;
}

export const ledgerClient = (client: Client, serviceToken: ServiceToken): Ledger => ({
  post: async (journal, idempotencyKey) =>
    client.post("/internal/ledger/journals", { body: journal, idempotencyKey, token: await serviceToken() }),
  reverse: async (reversal) =>
    client.post("/internal/ledger/journals/reverse", { body: reversal, token: await serviceToken() }),
});
