import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "@deus/config";
import { ConflictError, UnauthorizedError } from "@deus/errors";
import { createLogger } from "@deus/logger";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { SpanKind } from "@opentelemetry/api";
import { t } from "elysia";
import { createService } from "../src";

const { telemetry, spans, logs, metrics } = startTestTelemetry("http-test");
afterAll(() => telemetry.shutdown());
beforeEach(() => {
  spans.reset();
  logs.reset();
});

const config = loadConfig({}, { SERVICE_NAME: "http-test" });
const logger = createLogger({ name: "http-test", level: "debug" });
let ready = true;
const app = createService({
  config,
  logger,
  readiness: [
    () => {
      if (!ready) throw new Error("database unreachable");
    },
  ],
})
  .post("/items", ({ body }) => ({ id: "i-1", ...body }), { body: t.Object({ name: t.String({ minLength: 1 }) }) })
  .get("/conflict", () => {
    throw new ConflictError("Journal is already posted", { journalId: "j-1" });
  })
  .get("/denied", () => {
    throw new UnauthorizedError("The token is invalid", undefined, {
      cause: new Error("signature verification failed"),
    });
  })
  .get("/crash", () => {
    throw new Error("secret connection details");
  })
  .get("/items/:id", ({ params }) => ({ id: params.id }));

const call = (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));

async function serverSpan(route: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const span = spans
      .getFinishedSpans()
      .find((entry) => entry.kind === SpanKind.SERVER && entry.attributes["http.route"] === route);
    if (span) return span;
    await Bun.sleep(5);
  }
  return undefined;
}

describe("createService", () => {
  test("reports liveness and readiness", async () => {
    expect((await call("/health/live")).status).toBe(200);
    expect((await call("/health/ready")).status).toBe(200);
    ready = false;
    const notReady = await call("/health/ready");
    await call("/health/ready");
    ready = true;
    expect(notReady.status).toBe(503);
    expect((await call("/health/ready")).status).toBe(200);
    const bodies = logs.getFinishedLogRecords().map((record) => record.body);
    expect(bodies.filter((body) => body === "readiness check failed")).toHaveLength(1);
    expect(bodies).toContain("readiness restored");
    app.store.service.draining = true;
    expect((await call("/health/ready")).status).toBe(503);
    app.store.service.draining = false;
  });

  test("stays quiet while a starting service waits for its dependencies", async () => {
    const starting = createService({
      config,
      logger,
      readiness: [
        () => {
          throw new Error("database unreachable");
        },
      ],
    });
    const response = await starting.handle(new Request("http://localhost/health/ready"));
    expect(response.status).toBe(503);
    expect(logs.getFinishedLogRecords().some((record) => record.body === "readiness check failed")).toBe(false);
  });

  test("answers unknown routes with a problem document", async () => {
    const response = await call("/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toStartWith("application/problem+json");
    expect(await response.json()).toMatchObject({ status: 404, code: "route_not_found", instance: "/nope" });
  });

  test("answers schema violations with every issue", async () => {
    const response = await call("/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: Array<{ path: string }> };
    expect(body).toMatchObject({ status: 400, code: "validation" });
    expect(body.errors[0]?.path).toBe("/name");
  });

  test("maps application errors and logs them as warnings", async () => {
    const response = await call("/conflict");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "conflict",
      detail: "Journal is already posted",
      errors: { journalId: "j-1" },
    });
    const record = logs.getFinishedLogRecords().find((entry) => entry.body === "request rejected");
    expect(record?.severityText).toBe("WARN");
    expect(record?.attributes["http.response.status_code"]).toBe(409);
    expect(record?.attributes["exception.message"]).toBe("Journal is already posted");
  });

  test("logs why a request was rejected", async () => {
    expect((await call("/denied")).status).toBe(401);
    const record = logs.getFinishedLogRecords().find((entry) => entry.body === "request rejected");
    expect(record?.attributes["exception.cause"]).toBe("Error: signature verification failed");
  });

  test("hides unexpected errors from the client and logs them with the stack", async () => {
    const response = await call("/crash");
    expect(response.status).toBe(500);
    const body = (await response.json()) as { traceId?: string };
    expect(body).toMatchObject({ status: 500, code: "internal" });
    expect(JSON.stringify(body)).not.toContain("secret");
    const record = logs.getFinishedLogRecords().find((entry) => entry.body === "request failed");
    expect(record?.severityText).toBe("ERROR");
    expect(record?.attributes["exception.message"]).toBe("secret connection details");
    expect(record?.attributes["http.route"]).toBe("/crash");
    expect(body.traceId).toBe(record?.spanContext?.traceId);
  });

  test("continues the caller's trace and records the route", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    await call("/items/42", { headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` } });
    const server = await serverSpan("/items/:id");
    expect(server?.spanContext().traceId).toBe(traceId);
    expect(server?.attributes["http.route"]).toBe("/items/:id");
    expect(server?.attributes["http.response.status_code"]).toBe(200);
  });

  test("does not trace health checks", async () => {
    await call("/health/live");
    await Bun.sleep(20);
    expect(spans.getFinishedSpans()).toHaveLength(0);
  });

  test("records the HTTP server duration histogram", async () => {
    await call("/items/7");
    await telemetry.forceFlush();
    const names = metrics
      .getMetrics()
      .flatMap((resource) =>
        resource.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.descriptor.name)),
      );
    expect(names).toContain("http.server.request.duration");
    const points = metrics
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics))
      .filter((metric) => metric.descriptor.name === "http.server.request.duration")
      .flatMap((metric) => metric.dataPoints.map((point) => point.attributes));
    expect(points).toContainEqual(
      expect.objectContaining({ "http.route": "/items/:id", "http.response.status_code": 200 }),
    );
    expect(names).toContain("process.memory.usage");
  });

  test("records the route and status of every request served over a real listener, once", async () => {
    const server = createService({ config, logger })
      .group("/api/served", (api) =>
        api
          .resolve(() => ({ user: "u-1" }))
          .get("/items/:id", ({ params, user }) => ({ id: params.id, user }))
          .get("/raw", () => new Response("down", { status: 503 }))
          .get("/conflict", () => {
            throw new ConflictError("Journal is already posted");
          }),
      )
      .listen(0);
    try {
      const base = `http://localhost:${server.server?.port}`;
      for (const path of ["/api/served/items/9", "/api/served/raw", "/api/served/conflict", "/health/live"]) {
        await (await fetch(base + path)).text();
      }
    } finally {
      await server.stop();
    }
    await telemetry.forceFlush();
    const points = metrics
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics.map((metric) => ({ scope: scope.scope.name, metric })))
      .filter(({ metric }) => metric.descriptor.name === "http.server.request.duration")
      .flatMap(({ scope, metric }) => metric.dataPoints.map((point) => ({ scope, attributes: point.attributes })));
    expect(points.every((point) => point.scope === "@deus/http")).toBe(true);
    const served = points
      .map((point) => point.attributes)
      .filter((attributes) => String(attributes["http.route"]).startsWith("/api/served"));
    expect(served).toHaveLength(3);
    expect(served).toContainEqual(
      expect.objectContaining({ "http.route": "/api/served/items/:id", "http.response.status_code": 200 }),
    );
    expect(served).toContainEqual(
      expect.objectContaining({
        "http.route": "/api/served/raw",
        "http.response.status_code": 503,
        "error.type": "503",
      }),
    );
    expect(served).toContainEqual(
      expect.objectContaining({ "http.route": "/api/served/conflict", "http.response.status_code": 409 }),
    );
  });
});
