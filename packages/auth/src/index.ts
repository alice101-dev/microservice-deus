import { ForbiddenError, UnauthorizedError } from "@deus/errors";
import { Elysia } from "elysia";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export interface Principal {
  userId: string;
  email: string;
  organizationId: string | null;
  token: string;
}

export interface VerifierOptions {
  jwksUrl?: string;
  keys?: JWTVerifyGetKey;
  issuer: string;
  audience: string;
}

export type Verifier = (token: string) => Promise<Principal>;

export function createVerifier(options: VerifierOptions): Verifier {
  const keys =
    options.keys ??
    createRemoteJWKSet(new URL(options.jwksUrl ?? ""), { cacheMaxAge: 10 * 60 * 1000, cooldownDuration: 30 * 1000 });
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: options.issuer,
      audience: options.audience,
      algorithms: ["EdDSA"],
    });
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
      throw new Error("token without subject or email");
    }
    return {
      userId: payload.sub,
      email: payload.email,
      organizationId: typeof payload.org === "string" ? payload.org : null,
      token,
    };
  };
}

export function authentication(verify: Verifier) {
  return new Elysia({ name: "@deus/auth" }).resolve({ as: "scoped" }, async ({ headers }) => {
    const header = headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedError("A bearer token is required");
    try {
      return { principal: await verify(header.slice("Bearer ".length)) };
    } catch (error) {
      throw new UnauthorizedError("The token is invalid or expired", undefined, { cause: error });
    }
  });
}

export function requireOrganization(principal: Principal): string {
  if (!principal.organizationId) throw new ForbiddenError("Select an organization first");
  return principal.organizationId;
}
