import {
  accountsByCode,
  accountsLookup,
  contactsLookup,
  ledgerClient,
  notificationClient,
  productsLookup,
} from "@deus/clients";
import { createClient } from "@deus/http";
import { createRelay } from "@deus/outbox";
import { startService } from "@deus/runtime";
import { Type } from "@sinclair/typebox";
import { createApp } from "./app";
import { salesHandlers } from "./handlers";
import { schema } from "./schema";

startService({
  config: {
    ACCOUNTS_URL: Type.String({ default: "http://accounts" }),
    CONTACTS_URL: Type.String({ default: "http://contacts" }),
    PRODUCTS_URL: Type.String({ default: "http://products" }),
    LEDGER_URL: Type.String({ default: "http://ledger" }),
    NOTIFICATION_URL: Type.String({ default: "http://notification" }),
    UPSTREAM_TIMEOUT_MS: Type.Integer({ default: 3000 }),
    RECEIVABLE_ACCOUNT_CODE: Type.String({ default: "1-1200" }),
    VAT_OUTPUT_ACCOUNT_CODE: Type.String({ default: "2-1100" }),
  },
  schema,
  build: (context) => {
    const { config, serviceToken } = context;
    const client = (name: string, baseUrl: string) =>
      createClient({ name, baseUrl, timeoutMs: config.UPSTREAM_TIMEOUT_MS });
    const accounts = client("accounts", config.ACCOUNTS_URL);
    const ledger = ledgerClient(client("ledger", config.LEDGER_URL), serviceToken);
    const relay = createRelay({
      db: context.db,
      logger: context.logger,
      handlers: salesHandlers(
        ledger,
        notificationClient(client("notification", config.NOTIFICATION_URL), serviceToken),
      ),
    });
    relay.start();
    context.onShutdown(() => relay.stop());
    return createApp({
      ...context,
      accounts: accountsLookup(accounts, serviceToken),
      accountsByCode: accountsByCode(accounts, serviceToken),
      contacts: contactsLookup(client("contacts", config.CONTACTS_URL), serviceToken),
      products: productsLookup(client("products", config.PRODUCTS_URL), serviceToken),
      receivableAccountCode: config.RECEIVABLE_ACCOUNT_CODE,
      vatOutputAccountCode: config.VAT_OUTPUT_ACCOUNT_CODE,
    });
  },
});
