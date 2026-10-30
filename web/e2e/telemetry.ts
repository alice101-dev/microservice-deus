import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = join(import.meta.dir, "../build");
const USER = "00000000-0000-4000-8000-0000000000a1";
const ORG = "00000000-0000-4000-8000-0000000000b1";
const EMAIL = "pemilik@contoh.example";

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
  user: { id: USER, name: "Pemilik", email: EMAIL },
};

type OtlpSpan = { traceId: string; spanId: string; parentSpanId?: string; name: string; attributes?: OtlpAttribute[] };
type OtlpAttribute = { key: string; value: { stringValue?: string; intValue?: string } };
const exported: Array<{ resource: Record<string, string>; span: OtlpSpan }> = [];
const logged: Array<Record<string, string>> = [];
const DUMP = process.env.OTLP_DUMP;
if (DUMP) mkdirSync(DUMP, { recursive: true });
let dumped = 0;
const dump = (signal: string, body: unknown) => {
  if (DUMP) writeFileSync(join(DUMP, `${signal}-${String(++dumped).padStart(3, "0")}.json`), JSON.stringify(body));
};
const flat = (attributes: OtlpAttribute[] = []) =>
  Object.fromEntries(attributes.map((a) => [a.key, a.value.stringValue ?? a.value.intValue ?? ""]));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: process.env.HEADED !== "1",
});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, locale: "id-ID" });

await page.route("**/otlp/v1/traces", async (route) => {
  const body = route.request().postDataJSON() as {
    resourceSpans: Array<{ resource: { attributes: OtlpAttribute[] }; scopeSpans: Array<{ spans: OtlpSpan[] }> }>;
  };
  dump("traces", body);
  for (const resourceSpan of body.resourceSpans) {
    for (const scope of resourceSpan.scopeSpans) {
      for (const span of scope.spans) exported.push({ resource: flat(resourceSpan.resource.attributes), span });
    }
  }
  await route.fulfill({ status: 200, body: "{}" });
});
await page.route("**/otlp/v1/logs", async (route) => {
  const body = route.request().postDataJSON() as {
    resourceLogs: Array<{
      scopeLogs: Array<{ logRecords: Array<{ attributes?: OtlpAttribute[]; body?: { stringValue?: string } }> }>;
    }>;
  };
  dump("logs", body);
  for (const resource of body.resourceLogs) {
    for (const scope of resource.scopeLogs) {
      for (const record of scope.logRecords)
        logged.push({ body: record.body?.stringValue ?? "", ...flat(record.attributes) });
    }
  }
  await route.fulfill({ status: 200, body: "{}" });
});
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

await page.goto(`${BASE}/contacts`);
await page.waitForLoadState("networkidle");
await page.getByRole("link", { name: "Penjualan" }).first().click();
await page.waitForURL("**/sales");
await page.waitForLoadState("networkidle");
await page.waitForTimeout(1500);
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
});
await page.waitForTimeout(2000);

const fetches = exported.filter((entry) => /^(GET|POST|PUT|PATCH|DELETE) \//.test(entry.span.name));
const urlOf = (entry: { span: OtlpSpan }) => {
  const attributes = flat(entry.span.attributes);
  return attributes["url.full"] ?? attributes["http.url"] ?? "";
};

expect(
  fetches.some((entry) => entry.span.name === "GET /api/contacts"),
  "the contacts request of the first page is traced as GET /api/contacts",
);
expect(
  fetches.some((entry) => entry.span.name === "GET /api/sales/invoices"),
  "the sales list request after clicking Penjualan is traced as GET /api/sales/invoices",
);
expect(
  fetches.length > 0 && fetches.every((entry) => !entry.span.parentSpanId),
  "every request from the browser starts its own trace",
);
expect(
  !exported.some((entry) => /^(click|navigation|pageload)\b/.test(entry.span.name)),
  "there are no click, navigation or page load spans",
);
expect(
  !exported.some((entry) => entry.span.name !== "resourceFetch" && urlOf(entry).includes("/_app/")),
  "requests for the app's own files, such as the version check, are not traced",
);
expect(!JSON.stringify(exported).includes(EMAIL), "the user's email never leaves the browser in spans");
expect(
  exported.some((entry) => entry.span.name === "documentLoad"),
  "document load timing is traced",
);
expect(
  logged.some((record) => record.body === "web vital" && record["app.route"] === "/sales"),
  "Web Vitals are logged with the page",
);

process.stdout.write(
  `\n${exported.length} spans: ${[...new Set(exported.map((entry) => entry.span.name))].join(", ")}\n`,
);
await browser.close();
server.stop();
if (failures.length > 0) process.exit(1);
