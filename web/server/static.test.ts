import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@deus/config";
import { createLogger } from "@deus/logger";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { createWebServer } from "./static.ts";

const { telemetry } = startTestTelemetry("web-test");
afterAll(() => telemetry.shutdown());

let root = "";
let app: ReturnType<typeof createWebServer>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "web-"));
  await mkdir(join(root, "_app/immutable/entry"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><title>Deus</title>");
  await writeFile(join(root, "favicon.svg"), "<svg/>");
  await writeFile(join(root, "_app/immutable/entry/start.abc.js"), "export {}");
  await writeFile(join(tmpdir(), "secret.txt"), "secret");
  app = createWebServer({
    config: loadConfig({}, { SERVICE_NAME: "web" }),
    logger: createLogger({ name: "web" }),
    root,
  });
});
afterAll(() => rm(root, { recursive: true, force: true }));

const get = (path: string) => app.handle(new Request(`http://localhost${path}`));

describe("web server", () => {
  test("serves hashed assets as immutable and other files without caching", async () => {
    const asset = await get("/_app/immutable/entry/start.abc.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const icon = await get("/favicon.svg");
    expect(icon.headers.get("cache-control")).toBe("no-cache");
    expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("falls back to the SPA for routes and 404s for missing files", async () => {
    const route = await get("/sales/0000");
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("<title>Deus</title>");
    expect(route.headers.get("x-frame-options")).toBe("DENY");
    expect((await get("/_app/immutable/missing.js")).status).toBe(404);
    expect((await get("/api/sales/invoices")).status).toBe(404);
  });

  test("never serves files outside the build directory", async () => {
    expect((await get("/../secret.txt")).status).not.toBe(200);
    expect((await get("/%2e%2e/secret.txt")).status).toBe(404);
    expect((await get("/health/live")).status).toBe(200);
  });
});
