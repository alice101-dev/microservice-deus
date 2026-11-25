import { accountsLookup } from "@deus/clients";
import { createClient } from "@deus/http";
import { startService } from "@deus/runtime";
import { Type } from "@sinclair/typebox";
import { createApp } from "./app";
import { schema } from "./schema";

startService({
  config: {
    ACCOUNTS_URL: Type.String({ default: "http://accounts" }),
    ACCOUNTS_TIMEOUT_MS: Type.Integer({ default: 3000 }),
  },
  schema,
  build: (context) =>
    createApp({
      ...context,
      accounts: accountsLookup(
        createClient({
          name: "accounts",
          baseUrl: context.config.ACCOUNTS_URL,
          timeoutMs: context.config.ACCOUNTS_TIMEOUT_MS,
        }),
        context.serviceToken,
      ),
    }),
});
