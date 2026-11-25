import { join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = join(import.meta.dir, "../build");
const ORG = "00000000-0000-4000-8000-0000000000b1";
const USER = "00000000-0000-4000-8000-0000000000a1";

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(join(ROOT, path === "/" ? "index.html" : path));
    if (path !== "/" && (await file.exists())) return new Response(file);
    return new Response(Bun.file(join(ROOT, "index.html")), { headers: { "content-type": "text/html" } });
  },
});
const BASE = `http://localhost:${server.port}`;

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${base64url({ alg: "none" })}.${base64url({ exp: Math.floor(Date.now() / 1000) + 3600, org: ORG })}.x`;
const session = {
  session: {
    id: "s1",
    userId: USER,
    activeOrganizationId: ORG,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  },
  user: { id: USER, name: "Pemilik", email: "pemilik@contoh.example" },
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: process.env.HEADED !== "1",
});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, locale: "id-ID" });

let deployed: string | undefined;
let checks = 0;
await page.route("**/_app/version.json", async (route) => {
  checks++;
  if (!deployed) return route.continue();
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: deployed }) });
});
await page.route("**/otlp/**", (route) => route.fulfill({ status: 200, body: "{}" }));
await page.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  const json = (value: unknown) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  if (path.endsWith("/auth/get-session")) return json(session);
  if (path.endsWith("/auth/organization/list")) return json([{ id: ORG, name: "PT Uji", slug: "uji" }]);
  if (path.endsWith("/auth/token")) return json({ token });
  return json(route.request().method() === "GET" ? [] : {});
});

const failures: string[] = [];
const expect = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  process.stdout.write(`${ok ? "✓" : "✗"} ${message}\n`);
};
const sameDocument = () => page.evaluate(() => (window as unknown as { marker?: boolean }).marker === true);
const mark = () => page.evaluate(() => Object.assign(window, { marker: true }));
const open = async (name: string, path: string) => {
  await page.getByRole("link", { name }).first().click();
  await page.waitForURL(`**${path}`);
  await page.waitForLoadState("networkidle");
};

await page.goto(`${BASE}/contacts`);
await page.waitForLoadState("networkidle");
await mark();
await open("Penjualan", "/sales");
expect(await sameDocument(), "without a new deployment, a menu click stays a client-side navigation");

deployed = "a-newer-build";
await page.evaluate(() => window.dispatchEvent(new Event("focus")));
await page.waitForTimeout(1000);
expect(checks > 0, "returning to the tab checks for a new version");
await open("Kontak", "/contacts");
expect(!(await sameDocument()), "after a new deployment, the next menu click loads the new version");

await browser.close();
server.stop();
if (failures.length > 0) process.exit(1);
