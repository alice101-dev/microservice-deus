import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: typeof location === "undefined" ? "http://localhost" : location.origin,
  basePath: "/api/identity/auth",
  plugins: [organizationClient()],
});

let cached: { token: string; expiresAt: number } | undefined;
let pending: Promise<string> | undefined;

function expiryOf(token: string) {
  const [, payload] = token.split(".");
  if (!payload) return 0;
  const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
  return (claims.exp ?? 0) * 1000;
}

export async function accessToken(force = false) {
  if (!force && cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
  pending ??= fetch("/api/identity/auth/token", { credentials: "include" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`token request failed with status ${response.status}`);
      const { token } = (await response.json()) as { token: string };
      cached = { token, expiresAt: expiryOf(token) };
      return token;
    })
    .finally(() => {
      pending = undefined;
    });
  return pending;
}

export function forgetToken() {
  cached = undefined;
}
