import { accountsLookup, balancesLookup, ledgerClient, paymentsLookup } from "@deus/clients";
import { createClient } from "@deus/http";
import { createRelay } from "@deus/outbox";
import { startService } from "@deus/runtime";
import { Type } from "@sinclair/typebox";
import { createApp, TOPICS } from "./app";
import { schema } from "./schema";

startService({
  config: {
    ACCOUNTS_URL: Type.String({ default: "http://accounts" }),
    PAYMENTS_URL: Type.String({ default: "http://payments" }),
    LEDGER_URL: Type.String({ default: "http://ledger" }),
    UPSTREAM_TIMEOUT_MS: Type.Integer({ default: 5000 }),
  },
  schema,
  build: (context) => {
    const { config, serviceToken } = context;
    const client = (name: string, baseUrl: string) =>
      createClient({ name, baseUrl, timeoutMs: config.UPSTREAM_TIMEOUT_MS });
    const ledgerHttp = client("ledger", config.LEDGER_URL);
    const ledger = ledgerClient(ledgerHttp, serviceToken);
    const relay = createRelay({
      db: context.db,
      logger: context.logger,
      handlers: {
        [TOPICS.journal]: async (event) => {
          await ledger.post(event.payload as Parameters<typeof ledger.post>[0], event.id);
        },
      },
    });
    relay.start();
    context.onShutdown(() => relay.stop());
    return createApp({
      ...context,
      accounts: accountsLookup(client("accounts", config.ACCOUNTS_URL), serviceToken),
      payments: paymentsLookup(client("payments", config.PAYMENTS_URL), serviceToken),
      balances: balancesLookup(ledgerHttp, serviceToken),
    });
  },
});
