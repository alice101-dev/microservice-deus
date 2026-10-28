import {
  accountsByCode,
  accountsLookup,
  allocationsClient,
  billsLookup,
  contactsLookup,
  invoicesLookup,
  ledgerClient,
} from "@deus/clients";
import { createClient } from "@deus/http";
import { createRelay } from "@deus/outbox";
import { startService } from "@deus/runtime";
import { Type } from "@sinclair/typebox";
import { createApp } from "./app";
import { paymentHandlers } from "./handlers";
import { schema } from "./schema";

startService({
  config: {
    ACCOUNTS_URL: Type.String({ default: "http://accounts" }),
    CONTACTS_URL: Type.String({ default: "http://contacts" }),
    SALES_URL: Type.String({ default: "http://sales" }),
    PURCHASES_URL: Type.String({ default: "http://purchases" }),
    LEDGER_URL: Type.String({ default: "http://ledger" }),
    UPSTREAM_TIMEOUT_MS: Type.Integer({ default: 3000 }),
    RECEIVABLE_ACCOUNT_CODE: Type.String({ default: "1-1200" }),
    PAYABLE_ACCOUNT_CODE: Type.String({ default: "2-1000" }),
  },
  schema,
  build: (context) => {
    const { config, serviceToken } = context;
    const client = (name: string, baseUrl: string) =>
      createClient({ name, baseUrl, timeoutMs: config.UPSTREAM_TIMEOUT_MS });
    const accounts = client("accounts", config.ACCOUNTS_URL);
    const sales = client("sales", config.SALES_URL);
    const purchases = client("purchases", config.PURCHASES_URL);
    const relay = createRelay({
      db: context.db,
      logger: context.logger,
      handlers: paymentHandlers({
        db: context.db,
        ledger: ledgerClient(client("ledger", config.LEDGER_URL), serviceToken),
        sales: allocationsClient(sales, "sales", serviceToken),
        purchases: allocationsClient(purchases, "purchases", serviceToken),
      }),
    });
    relay.start();
    context.onShutdown(() => relay.stop());
    return createApp({
      ...context,
      accounts: accountsLookup(accounts, serviceToken),
      accountsByCode: accountsByCode(accounts, serviceToken),
      contacts: contactsLookup(client("contacts", config.CONTACTS_URL), serviceToken),
      invoices: invoicesLookup(sales, serviceToken),
      bills: billsLookup(purchases, serviceToken),
      receivableAccountCode: config.RECEIVABLE_ACCOUNT_CODE,
      payableAccountCode: config.PAYABLE_ACCOUNT_CODE,
    });
  },
});
