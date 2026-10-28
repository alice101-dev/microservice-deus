import { join, normalize, resolve } from "node:path";
import { createService, type ServiceOptions } from "@deus/http";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
};

export function createWebServer(options: ServiceOptions & { root: string }) {
  const root = resolve(options.root);
  const fallback = Bun.file(join(root, "index.html"));

  const respond = (file: Blob, cacheControl: string, status = 200) =>
    new Response(file, { status, headers: { ...SECURITY_HEADERS, "cache-control": cacheControl } });

  return createService(options).get(
    "/*",
    async ({ request }) => {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const target = normalize(join(root, pathname));
      if (!target.startsWith(root)) return respond(new Blob(["Not found"]), "no-store", 404);
      const file = Bun.file(target);
      if (pathname !== "/" && (await file.exists())) {
        const immutable = pathname.startsWith("/_app/immutable/");
        return respond(file, immutable ? "public, max-age=31536000, immutable" : "no-cache");
      }
      if (/\.[a-z0-9]+$/i.test(pathname) || pathname.startsWith("/api/") || pathname.startsWith("/otlp/")) {
        return respond(new Blob(["Not found"]), "no-store", 404);
      }
      return respond(fallback, "no-cache");
    },
    { detail: { hide: true } },
  );
}
