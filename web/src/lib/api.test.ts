import { afterEach, describe, expect, test, vi } from "vitest";
import { api, call } from "./api.ts";
import { forgetToken } from "./auth.ts";

const jwt = `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).replace(/=+$/, "")}.s`;

afterEach(() => {
  forgetToken();
  vi.unstubAllGlobals();
});

describe("api client", () => {
  test("keeps dates as the strings the backend sends and sends the bearer token", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/identity/auth/token")) return Response.json({ token: jwt });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${jwt}`);
      return Response.json([{ id: "i1", issueDate: "2026-10-28", dueDate: "2026-11-11", number: "INV/2026/0001" }]);
    });
    vi.stubGlobal("fetch", fetch);
    const invoices = (await call(api.sales.invoices.get({ query: {} }))) as unknown as Array<{ issueDate: unknown }>;
    expect(invoices[0]?.issueDate).toBe("2026-10-28");
  });

  test("refreshes the token once when a service answers 401", async () => {
    let calls = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/identity/auth/token")) return Response.json({ token: jwt });
      calls++;
      return calls === 1 ? new Response(null, { status: 401 }) : Response.json([]);
    });
    vi.stubGlobal("fetch", fetch);
    await expect(call(api.contacts.get({ query: {} }))).resolves.toEqual([]);
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/token"))).toHaveLength(2);
  });
});
