import type { createApp as AccountsApp } from "@deus/accounts/app";
import type { createApp as BankingApp } from "@deus/banking/app";
import type { createApp as ContactsApp } from "@deus/contacts/app";
import type { createApp as LedgerApp } from "@deus/ledger/app";
import type { createApp as NotificationApp } from "@deus/notification/app";
import type { createApp as OrganizationApp } from "@deus/organization/app";
import type { createApp as PaymentsApp } from "@deus/payments/app";
import type { createApp as ProductsApp } from "@deus/products/app";
import type { createApp as PurchasesApp } from "@deus/purchases/app";
import type { createApp as ReportingApp } from "@deus/reporting/app";
import type { createApp as SalesApp } from "@deus/sales/app";
import type { createApp as TaxApp } from "@deus/tax/app";
import { treaty } from "@elysia/eden";
import { accessToken, forgetToken } from "./auth";
import { ApiError, type Problem } from "./errors";

async function authorized(input: RequestInfo | URL, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${await accessToken()}`);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401 && retry) {
    forgetToken();
    return authorized(input, init, false);
  }
  return response;
}

const options = { fetcher: authorized as typeof fetch, parseDate: false };
const origin = typeof location === "undefined" ? "http://localhost" : location.origin;

export const api = {
  organization: treaty<ReturnType<typeof OrganizationApp>>(origin, options).api.organization,
  accounts: treaty<ReturnType<typeof AccountsApp>>(origin, options).api.accounts,
  ledger: treaty<ReturnType<typeof LedgerApp>>(origin, options).api.ledger,
  contacts: treaty<ReturnType<typeof ContactsApp>>(origin, options).api.contacts,
  products: treaty<ReturnType<typeof ProductsApp>>(origin, options).api.products,
  sales: treaty<ReturnType<typeof SalesApp>>(origin, options).api.sales,
  purchases: treaty<ReturnType<typeof PurchasesApp>>(origin, options).api.purchases,
  payments: treaty<ReturnType<typeof PaymentsApp>>(origin, options).api.payments,
  reporting: treaty<ReturnType<typeof ReportingApp>>(origin, options).api.reporting,
  tax: treaty<ReturnType<typeof TaxApp>>(origin, options).api.tax,
  banking: treaty<ReturnType<typeof BankingApp>>(origin, options).api.banking,
  notification: treaty<ReturnType<typeof NotificationApp>>(origin, options).api.notification,
};

interface TreatyResult<T> {
  data: T | null;
  error: { status: unknown; value: unknown } | null;
  response: Response;
}

type ProblemBody = { type: string; title: string; status: number; code: string };

export async function call<T>(request: Promise<TreatyResult<T>>): Promise<Exclude<T, ProblemBody>> {
  const { data, error, response } = await request;
  if (error) {
    const status = typeof error.status === "number" ? error.status : response.status;
    const value = error.value;
    const problem: Problem =
      value && typeof value === "object" && "status" in value
        ? (value as Problem)
        : { status, detail: String(value ?? "") };
    throw new ApiError(status, problem, new URL(response.url || origin).pathname);
  }
  return data as Exclude<T, ProblemBody>;
}
