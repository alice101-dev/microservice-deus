import { afterAll, expect, test } from "bun:test";
import { loadConfig } from "@deus/config";
import { createLogger } from "@deus/logger";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { createApp } from "../src/app";

const { telemetry } = startTestTelemetry("identity");
afterAll(() => telemetry.shutdown());

test("answers the ping route", async () => {
  const app = createApp(
    loadConfig({}, { SERVICE_NAME: "identity", SERVICE_VERSION: "abc123" }),
    createLogger({ name: "identity" }),
  );
  const response = await app.handle(new Request("http://localhost/api/identity/ping"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ service: "identity", version: "abc123" });
});
