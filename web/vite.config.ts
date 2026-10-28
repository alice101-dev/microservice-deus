import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vitest/config";

const gateway = process.env.DEUS_GATEWAY ?? "http://localhost:8080";

export default defineConfig({
  plugins: [
    sveltekit({ adapter: adapter({ pages: "build", assets: "build", fallback: "index.html", strict: true }) }),
    svelteTesting(),
  ],
  server: {
    port: 5173,
    proxy: { "/api": gateway, "/otlp": gateway },
  },
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? "dev"),
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
