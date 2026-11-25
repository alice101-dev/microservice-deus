import { CacheConfig, DatabaseConfig, loadConfig } from "@deus/config";
import { Type } from "@sinclair/typebox";

export const IdentityConfig = {
  ...DatabaseConfig,
  ...CacheConfig,
  BETTER_AUTH_SECRET: Type.String({ minLength: 32 }),
  AUTH_BASE_URL: Type.String({ minLength: 1 }),
  AUTH_TRUSTED_ORIGINS: Type.String({ default: "" }),
  AUTH_ISSUER: Type.String({ default: "deus-identity" }),
};

export function loadIdentityConfig(env: Record<string, string | undefined> = process.env) {
  return loadConfig(IdentityConfig, env);
}

export type IdentityConfig = ReturnType<typeof loadIdentityConfig>;
