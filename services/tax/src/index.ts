import { accountsByCode, balancesLookup, ledgerClient } from "@deus/clients";
import { createClient } from "@deus/http";
import { createRelay } from "@deus/outbox";
import { startService } from "@deus/runtime";
import { Type } from "@sinclair/typebox";
import { createApp, TOPICS } from "./app";
import { schema } from "./schema";

startService({
  config: {
    ACCOUNTS_URL: Type.String({ default: "http://accounts" }),
    LEDGER_URL: Type.String({ default: "http://ledger" }),
    UPSTREAM_TIMEOUT_MS: Type.Integer({ default: 5000 }),
    VAT_OUTPUT_ACCOUNT_CODE: Type.String({ default: "2-1100" }),
    VAT_INPUT_ACCOUNT_CODE: Type.String({ default: "1-1400" }),
    TAX_PAYABLE_ACCOUNT_CODE: Type.String({ default: "2-1200" }),
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
      accountsByCode: accountsByCode(client("accounts", config.ACCOUNTS_URL), serviceToken),
      balances: balancesLookup(ledgerHttp, serviceToken),
      vatOutputAccountCode: config.VAT_OUTPUT_ACCOUNT_CODE,
      vatInputAccountCode: config.VAT_INPUT_ACCOUNT_CODE,
      taxPayableAccountCode: config.TAX_PAYABLE_ACCOUNT_CODE,
    });
  },
});
