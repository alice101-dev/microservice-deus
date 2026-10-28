import { afterEach, describe, expect, test, vi } from "vitest";
import { accessToken, forgetToken } from "./auth.ts";

const jwt = (exp: number) => `h.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.s`;

afterEach(() => {
  forgetToken();
  vi.unstubAllGlobals();
});

describe("access token", () => {
  test("caches the JWT until a minute before it expires", async () => {
    const fetch = vi.fn(async () => Response.json({ token: jwt(Math.floor(Date.now() / 1000) + 900) }));
    vi.stubGlobal("fetch", fetch);
    const first = await accessToken();
    expect(await accessToken()).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    await accessToken(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("refreshes a token that is about to expire and shares one request between callers", async () => {
    const fetch = vi.fn(async () => Response.json({ token: jwt(Math.floor(Date.now() / 1000) + 30) }));
    vi.stubGlobal("fetch", fetch);
    await Promise.all([accessToken(), accessToken(), accessToken()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await accessToken();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("fails when the session is gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(accessToken()).rejects.toThrow("401");
  });
});
