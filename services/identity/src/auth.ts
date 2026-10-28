import type { Logger } from "@deus/logger";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, organization } from "better-auth/plugins";

export interface AuthSettings {
  baseURL: string;
  secret: string;
  trustedOrigins: string[];
  issuer: string;
  logger?: Logger;
}

function authLogger(logger: Logger | undefined) {
  if (!logger) return undefined;
  return {
    level: "info" as const,
    log: (level: "debug" | "info" | "warn" | "error", message: string, ...args: unknown[]) => {
      const error = args.find((arg) => arg instanceof Error);
      const details = args
        .filter((arg) => arg !== error)
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)));
      logger[level](message, { "auth.library": "better-auth", "auth.details": details.join(" ") || undefined }, error);
    },
  };
}

export const AUTH_BASE_PATH = "/api/identity/auth";

export function authOptions(settings: AuthSettings) {
  return {
    appName: "deus",
    baseURL: settings.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: settings.secret,
    trustedOrigins: settings.trustedOrigins,
    emailAndPassword: { enabled: true, minPasswordLength: 12, autoSignIn: true },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    advanced: { database: { generateId: "uuid" as const }, cookiePrefix: "deus" },
    telemetry: { enabled: false },
    logger: authLogger(settings.logger),
    plugins: [
      organization({ allowUserToCreateOrganization: true, creatorRole: "owner" }),
      jwt({
        jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } },
        jwt: {
          issuer: settings.issuer,
          audience: "deus",
          expirationTime: "15m",
          definePayload: ({ user, session }) => ({
            email: user.email,
            name: user.name,
            org: (session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
          }),
        },
      }),
    ],
  };
}

export function createAuth(
  settings: AuthSettings,
  db: Parameters<typeof drizzleAdapter>[0],
  schema: Record<string, unknown>,
) {
  return betterAuth({
    ...authOptions(settings),
    database: drizzleAdapter(db, { provider: "pg", schema }),
  });
}

export type Auth = ReturnType<typeof createAuth>;
