import { ForbiddenError, UnauthorizedError } from "@deus/errors";
import { Elysia } from "elysia";
import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey, jwtVerify } from "jose";

export const SERVICE_AUDIENCE = "deus-services";

export interface ServicePrincipal {
  service: string;
  namespace: string;
}

export type ServiceVerifier = (token: string) => Promise<ServicePrincipal>;

export interface ServiceVerifierOptions {
  keys: JWTVerifyGetKey;
  issuer: () => Promise<string>;
  namespace: string;
  audience?: string;
}

interface KubernetesClaims {
  "kubernetes.io"?: { namespace?: string; serviceaccount?: { name?: string } };
}

export function createServiceVerifier(options: ServiceVerifierOptions): ServiceVerifier {
  return async (token) => {
    const { payload } = await jwtVerify<KubernetesClaims>(token, options.keys, {
      issuer: await options.issuer(),
      audience: options.audience ?? SERVICE_AUDIENCE,
      algorithms: ["RS256", "ES256"],
    });
    const namespace = payload["kubernetes.io"]?.namespace;
    const service = payload["kubernetes.io"]?.serviceaccount?.name;
    if (!namespace || !service) throw new Error("token without a Kubernetes service account");
    if (namespace !== options.namespace) throw new Error(`service account of namespace ${namespace}`);
    return { service, namespace };
  };
}

export interface KubernetesOptions {
  apiUrl: string;
  tokenFile: string;
  caFile?: string;
  refreshMs?: number;
  cooldownMs?: number;
}

export function kubernetesKeys(options: KubernetesOptions) {
  const refreshMs = options.refreshMs ?? 10 * 60 * 1000;
  const cooldownMs = options.cooldownMs ?? 30_000;
  const request = async <T>(path: string): Promise<T> => {
    const token = (await Bun.file(options.tokenFile).text()).trim();
    const ca = options.caFile ? await Bun.file(options.caFile).text() : undefined;
    const response = await fetch(new URL(path, options.apiUrl), {
      headers: { authorization: `Bearer ${token}`, accept: "application/jwk-set+json, application/json" },
      signal: AbortSignal.timeout(5000),
      ...(ca ? { tls: { ca } } : {}),
    });
    if (!response.ok) throw new Error(`Kubernetes ${path} answered ${response.status}`);
    return (await response.json()) as T;
  };
  let issuer: Promise<string> | undefined;
  let keys: { get: JWTVerifyGetKey; loadedAt: number } | undefined;
  let loading: Promise<JWTVerifyGetKey> | undefined;
  const load = () => {
    loading ??= request<JSONWebKeySet>("/openid/v1/jwks")
      .then((set) => {
        keys = { get: createLocalJWKSet(set), loadedAt: Date.now() };
        return keys.get;
      })
      .finally(() => {
        loading = undefined;
      });
    return loading;
  };
  const get: JWTVerifyGetKey = async (header, token) => {
    const current = !keys || Date.now() - keys.loadedAt > refreshMs ? await load() : keys.get;
    try {
      return await current(header, token);
    } catch (error) {
      if (
        (error as { code?: string }).code !== "ERR_JWKS_NO_MATCHING_KEY" ||
        Date.now() - (keys?.loadedAt ?? 0) < cooldownMs
      ) {
        throw error;
      }
      return (await load())(header, token);
    }
  };
  return {
    keys: get,
    issuer: () => {
      issuer ??= request<{ issuer: string }>("/.well-known/openid-configuration")
        .then((document) => document.issuer)
        .catch((error) => {
          issuer = undefined;
          throw error;
        });
      return issuer;
    },
  };
}

export function serviceTokenSource(file: string, cacheMs = 60_000) {
  let cached: { token: string; readAt: number } | undefined;
  return async () => {
    if (!cached || Date.now() - cached.readAt > cacheMs) {
      cached = { token: (await Bun.file(file).text()).trim(), readAt: Date.now() };
    }
    return cached.token;
  };
}

export function serviceAuthentication(verify: ServiceVerifier, allowed: readonly string[]) {
  return new Elysia({ name: "@deus/auth/service", seed: allowed }).resolve({ as: "scoped" }, async ({ headers }) => {
    const header = headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedError("A service token is required");
    let caller: ServicePrincipal;
    try {
      caller = await verify(header.slice("Bearer ".length));
    } catch (error) {
      throw new UnauthorizedError("The service token is invalid or expired", undefined, { cause: error });
    }
    if (!allowed.includes(caller.service)) {
      throw new ForbiddenError(`Service ${caller.service} may not call this endpoint`);
    }
    return { caller };
  });
}
