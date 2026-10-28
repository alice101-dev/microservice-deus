import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@deus/config";
import { createService } from "@deus/http";
import { createLogger } from "@deus/logger";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  createServiceVerifier,
  kubernetesKeys,
  SERVICE_AUDIENCE,
  serviceAuthentication,
  serviceTokenSource,
} from "../src";

const { telemetry } = startTestTelemetry("service-auth-test");
const ISSUER = "https://kubernetes.test/issuer";
const directory = await mkdtemp(join(tmpdir(), "service-auth-"));
const tokenFile = join(directory, "token");
await writeFile(tokenFile, "kube-api-token\n");

const first = await generateKeyPair("RS256");
const second = await generateKeyPair("RS256");
const served = [{ ...(await exportJWK(first.publicKey)), kid: "k1", alg: "RS256", use: "sig" }];
let jwksRequests = 0;
const api = Bun.serve({
  port: 0,
  fetch(request) {
    if (request.headers.get("authorization") !== "Bearer kube-api-token") return new Response("", { status: 401 });
    const { pathname } = new URL(request.url);
    if (pathname === "/.well-known/openid-configuration") return Response.json({ issuer: ISSUER });
    if (pathname === "/openid/v1/jwks") {
      if (!request.headers.get("accept")?.includes("application/jwk-set+json"))
        return new Response("", { status: 406 });
      jwksRequests++;
      return new Response(JSON.stringify({ keys: served }), {
        headers: { "content-type": "application/jwk-set+json" },
      });
    }
    return new Response("", { status: 404 });
  },
});
afterAll(async () => {
  api.stop(true);
  await rm(directory, { recursive: true, force: true });
  await telemetry.shutdown();
});

const sign = (
  claims: { namespace?: string; service?: string; audience?: string; kid?: string } = {},
  key = first.privateKey,
) =>
  new SignJWT({
    "kubernetes.io": {
      namespace: claims.namespace ?? "staging-deus",
      serviceaccount: { name: claims.service ?? "sales", uid: "u-1" },
    },
  })
    .setProtectedHeader({ alg: "RS256", kid: claims.kid ?? "k1" })
    .setSubject(`system:serviceaccount:${claims.namespace ?? "staging-deus"}:${claims.service ?? "sales"}`)
    .setIssuer(ISSUER)
    .setAudience(claims.audience ?? SERVICE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);

const kubernetes = kubernetesKeys({ apiUrl: `http://localhost:${api.port}`, tokenFile, cooldownMs: 0 });
const verify = createServiceVerifier({ ...kubernetes, namespace: "staging-deus" });
const app = createService({
  config: loadConfig({}, { SERVICE_NAME: "service-auth-test" }),
  logger: createLogger({ name: "service-auth-test" }),
})
  .use(serviceAuthentication(verify, ["sales", "purchases"]))
  .get("/internal/whoami", ({ caller }) => caller);
const call = (token?: string) =>
  app.handle(
    new Request("http://localhost/internal/whoami", token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  );

describe("service authentication", () => {
  test("accepts a projected service account token of an allowed service in the namespace", async () => {
    const response = await call(await sign());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "sales", namespace: "staging-deus" });
  });

  test("refuses other services, namespaces, audiences and missing tokens", async () => {
    expect((await call(await sign({ service: "reporting" }))).status).toBe(403);
    expect((await call(await sign({ namespace: "other" }))).status).toBe(401);
    expect((await call(await sign({ audience: "https://kubernetes.default.svc" }))).status).toBe(401);
    expect((await call()).status).toBe(401);
    expect((await call("not-a-token")).status).toBe(401);
  });

  test("reloads the keys when the cluster rotates its signing key", async () => {
    served.push({ ...(await exportJWK(second.publicKey)), kid: "k2", alg: "RS256", use: "sig" });
    const before = jwksRequests;
    expect((await call(await sign({ kid: "k2" }, second.privateKey))).status).toBe(200);
    expect(jwksRequests).toBe(before + 1);
    expect((await call(await sign({ kid: "k2" }, second.privateKey))).status).toBe(200);
    expect(jwksRequests).toBe(before + 1);
  });

  test("reads the projected token file and caches it", async () => {
    const file = join(directory, "service-token");
    await writeFile(file, "token-1\n");
    const token = serviceTokenSource(file, 60_000);
    expect(await token()).toBe("token-1");
    await writeFile(file, "token-2\n");
    expect(await token()).toBe("token-1");
    expect(await serviceTokenSource(file, 0)()).toBe("token-2");
  });
});
