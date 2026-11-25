import { afterAll, describe, expect, test } from "bun:test";
import { loadConfig } from "@deus/config";
import { createService } from "@deus/http";
import { createLogger } from "@deus/logger";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { authentication, createVerifier, requireOrganization } from "../src";

const { telemetry } = startTestTelemetry("auth-test");
const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA" };
const server = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
afterAll(async () => {
  server.stop(true);
  await telemetry.shutdown();
});

const sign = (claims: Record<string, unknown>, options: { issuer?: string; expires?: string } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setSubject("user-1")
    .setIssuer(options.issuer ?? "deus-identity")
    .setAudience("deus")
    .setIssuedAt()
    .setExpirationTime(options.expires ?? "5m")
    .sign(privateKey);

const verify = createVerifier({
  jwksUrl: `http://localhost:${server.port}/jwks`,
  issuer: "deus-identity",
  audience: "deus",
});
const app = createService({
  config: loadConfig({}, { SERVICE_NAME: "auth-test" }),
  logger: createLogger({ name: "auth-test" }),
})
  .use(authentication(verify))
  .get("/whoami", ({ principal }) => ({ user: principal.userId, organization: requireOrganization(principal) }));
const call = (token?: string) =>
  app.handle(new Request("http://localhost/whoami", token ? { headers: { authorization: `Bearer ${token}` } } : {}));

describe("authentication", () => {
  test("accepts a valid token and exposes the principal", async () => {
    const response = await call(await sign({ email: "a@example.com", org: "org-1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: "user-1", organization: "org-1" });
  });

  test("rejects a missing, expired or foreign token", async () => {
    expect((await call()).status).toBe(401);
    expect((await call(await sign({ email: "a@example.com", org: "org-1" }, { expires: "-1m" }))).status).toBe(401);
    expect((await call(await sign({ email: "a@example.com", org: "org-1" }, { issuer: "someone-else" }))).status).toBe(
      401,
    );
    expect((await call("not-a-jwt")).status).toBe(401);
  });

  test("forbids routes that need an organization when none is active", async () => {
    const response = await call(await sign({ email: "a@example.com", org: null }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
  });
});
