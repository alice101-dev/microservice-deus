import {
  authentication,
  requireOrganization,
  type ServiceVerifier,
  serviceAuthentication,
  type Verifier,
} from "@deus/auth";
import type { BaseConfig } from "@deus/config";
import { type Database, withTenant } from "@deus/db";
import { NotFoundError } from "@deus/errors";
import { createService } from "@deus/http";
import type { Logger } from "@deus/logger";
import { t } from "elysia";
import { type Profile, profiles, type schema } from "./schema";

export interface OrganizationContext {
  config: BaseConfig;
  logger: Logger;
  db: Database<typeof schema>;
  verify: Verifier;
  verifyService: ServiceVerifier;
  readiness?: Array<() => Promise<void>>;
}

const ProfileView = t.Object({
  organizationId: t.String(),
  legalName: t.String(),
  taxId: t.Nullable(t.String()),
  address: t.Nullable(t.String()),
  currency: t.Literal("IDR"),
  fiscalYearStartMonth: t.Integer(),
});

const view = (profile: Profile) => ({
  organizationId: profile.organizationId,
  legalName: profile.legalName,
  taxId: profile.taxId,
  address: profile.address,
  currency: "IDR" as const,
  fiscalYearStartMonth: profile.fiscalYearStartMonth,
});

export const PROFILE_CALLERS = ["reporting", "tax", "notification"] as const;

export function createApp(context: OrganizationContext) {
  const { db } = context;
  return createService({ config: context.config, logger: context.logger, readiness: context.readiness })
    .group("/api/organization", (api) =>
      api
        .use(authentication(context.verify))
        .get(
          "/profile",
          async ({ principal }) => {
            const [profile] = await withTenant(db, requireOrganization(principal), (tx) => tx.select().from(profiles));
            if (!profile) throw new NotFoundError("The organization has no profile yet");
            return view(profile);
          },
          { response: ProfileView, detail: { summary: "Company profile of the active organization" } },
        )
        .put(
          "/profile",
          async ({ principal, body }) => {
            const organizationId = requireOrganization(principal);
            const values = {
              legalName: body.legalName,
              taxId: body.taxId ?? null,
              address: body.address ?? null,
              fiscalYearStartMonth: body.fiscalYearStartMonth ?? 1,
            };
            const [profile] = await withTenant(db, organizationId, (tx) =>
              tx
                .insert(profiles)
                .values({ organizationId, ...values })
                .onConflictDoUpdate({ target: profiles.organizationId, set: { ...values, updatedAt: new Date() } })
                .returning(),
            );
            return view(profile as Profile);
          },
          {
            body: t.Object({
              legalName: t.String({ minLength: 1, maxLength: 200 }),
              taxId: t.Optional(t.Nullable(t.String({ pattern: "^[0-9]{15,16}$" }))),
              address: t.Optional(t.Nullable(t.String({ maxLength: 500 }))),
              fiscalYearStartMonth: t.Optional(t.Integer({ minimum: 1, maximum: 12 })),
            }),
            response: ProfileView,
            detail: { summary: "Create or update the company profile" },
          },
        ),
    )
    .group("/internal/organization", (internal) =>
      internal.use(serviceAuthentication(context.verifyService, PROFILE_CALLERS)).get(
        "/profile",
        async ({ query }) => {
          const [profile] = await withTenant(db, query.organizationId, (tx) => tx.select().from(profiles));
          if (!profile) throw new NotFoundError("The organization has no profile yet");
          return view(profile);
        },
        {
          query: t.Object({ organizationId: t.String({ format: "uuid" }) }),
          response: ProfileView,
          detail: { summary: "Company profile of an organization, for other services" },
        },
      ),
    );
}
