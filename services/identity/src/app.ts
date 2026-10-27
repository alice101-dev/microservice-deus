import type { BaseConfig } from "@deus/config";
import { createService } from "@deus/http";
import type { Logger } from "@deus/logger";
import { t } from "elysia";

export function createApp(config: BaseConfig, logger: Logger) {
  return createService({ config, logger }).group("/api/identity", (api) =>
    api.get("/ping", () => ({ service: config.SERVICE_NAME, version: config.SERVICE_VERSION }), {
      response: t.Object({ service: t.String(), version: t.String() }),
      detail: { summary: "Liveness of the identity API through the gateway" },
    }),
  );
}
