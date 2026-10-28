import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vitest/config";

const gateway = process.env.DEUS_GATEWAY ?? "http://localhost:8080";

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({ pages: "build", assets: "build", fallback: "index.html", strict: true }),
      csp: {
        mode: "hash",
        directives: {
          "default-src": ["self"],
          "script-src": ["self"],
          "style-src": ["self", "unsafe-inline"],
          "img-src": ["self", "data:"],
          "font-src": ["self"],
          "connect-src": ["self"],
          "object-src": ["none"],
          "base-uri": ["self"],
          "form-action": ["self"],
        },
      },
    }),
    svelteTesting(),
  ],
  server: {
    port: 5173,
    proxy: { "/api": gateway, "/otlp": gateway },
  },
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? "dev"),
    __APP_ENVIRONMENT__: JSON.stringify(process.env.APP_ENVIRONMENT ?? "staging"),
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
