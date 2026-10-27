import { UnauthorizedError } from "@deus/errors";
import { createService, type ReadinessCheck } from "@deus/http";
import type { Logger } from "@deus/logger";
import { t } from "elysia";
import { AUTH_BASE_PATH, type Auth } from "./auth";
import type { IdentityConfig } from "./config";

export function createApp(config: IdentityConfig, logger: Logger, auth: Auth, readiness: ReadinessCheck[] = []) {
  return createService({ config, logger, readiness })
    .all(`${AUTH_BASE_PATH}/*`, ({ request }) => auth.handler(request), { parse: "none", detail: { hide: true } })
    .group("/api/identity", (api) =>
      api
        .get("/ping", () => ({ service: config.SERVICE_NAME, version: config.SERVICE_VERSION }), {
          response: t.Object({ service: t.String(), version: t.String() }),
          detail: { summary: "Liveness of the identity API through the gateway" },
        })
        .get(
          "/me",
          async ({ request }) => {
            const current = await auth.api.getSession({ headers: request.headers });
            if (!current) throw new UnauthorizedError("Sign in first");
            return {
              id: current.user.id,
              email: current.user.email,
              name: current.user.name,
              activeOrganizationId:
                (current.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
            };
          },
          {
            response: t.Object({
              id: t.String(),
              email: t.String(),
              name: t.String(),
              activeOrganizationId: t.Nullable(t.String()),
            }),
            detail: { summary: "The signed-in user and their active organization" },
          },
        ),
    );
}
