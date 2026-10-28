import { balancesLookup, chartLookup, profileLookup } from "@deus/clients";
import { createClient } from "@deus/http";
import { startService } from "@deus/runtime";
import { Type } from "@sinclair/typebox";
import { createApp } from "./app";
import { schema } from "./schema";

startService({
  config: {
    ACCOUNTS_URL: Type.String({ default: "http://accounts" }),
    LEDGER_URL: Type.String({ default: "http://ledger" }),
    ORGANIZATION_URL: Type.String({ default: "http://organization" }),
    UPSTREAM_TIMEOUT_MS: Type.Integer({ default: 5000 }),
  },
  schema,
  build: (context) => {
    const { config, serviceToken } = context;
    const client = (name: string, baseUrl: string) =>
      createClient({ name, baseUrl, timeoutMs: config.UPSTREAM_TIMEOUT_MS });
    return createApp({
      ...context,
      chart: chartLookup(client("accounts", config.ACCOUNTS_URL), serviceToken),
      balances: balancesLookup(client("ledger", config.LEDGER_URL), serviceToken),
      profile: profileLookup(client("organization", config.ORGANIZATION_URL), serviceToken),
    });
  },
});
