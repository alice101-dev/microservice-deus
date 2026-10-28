import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "@deus/errors";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { SpanKind, trace } from "@opentelemetry/api";
import { createClient, UpstreamError } from "../src";

const { telemetry, spans } = startTestTelemetry("client-test");
const seen: Record<string, string | null>[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    seen.push({
      traceparent: request.headers.get("traceparent"),
      authorization: request.headers.get("authorization"),
      idempotency: request.headers.get("idempotency-key"),
      ids: url.searchParams.getAll("id").join(","),
    });
    if (url.pathname === "/ok") return Response.json({ ok: true });
    if (url.pathname === "/conflict")
      return Response.json({ code: "conflict", detail: "already posted" }, { status: 409 });
    if (url.pathname === "/denied") return Response.json({ code: "unauthorized" }, { status: 401 });
    if (url.pathname === "/slow") await Bun.sleep(200);
    return new Response("boom", { status: 500 });
  },
});
afterAll(async () => {
  server.stop(true);
  await telemetry.shutdown();
});
beforeEach(() => {
  seen.length = 0;
  spans.reset();
});

const client = createClient({ name: "accounts", baseUrl: `http://localhost:${server.port}`, timeoutMs: 100 });

describe("createClient", () => {
  test("propagates the trace, token, idempotency key and query", async () => {
    let traceId = "";
    await trace.getTracer("test").startActiveSpan("parent", async (span) => {
      traceId = span.spanContext().traceId;
      expect(await client.get("/ok", { token: "t", idempotencyKey: "k", query: { id: ["a", "b"] } })).toEqual({
        ok: true,
      });
      span.end();
    });
    expect(seen[0]?.traceparent).toContain(traceId);
    expect(seen[0]).toMatchObject({ authorization: "Bearer t", idempotency: "k", ids: "a,b" });
    const client_span = spans.getFinishedSpans().find((span) => span.kind === SpanKind.CLIENT);
    expect(client_span?.name).toBe("GET accounts");
    expect(client_span?.attributes["http.response.status_code"]).toBe(200);
  });

  test("passes client errors of the upstream through", async () => {
    const error = await client.post("/conflict").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, code: "conflict", message: "already posted" });
  });

  test("reports a refused service call as a gateway error, not as the caller's 401", async () => {
    const error = await client.get("/denied").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 502, code: "upstream_failed", upstream: "accounts" });
  });

  test("turns upstream failures and timeouts into gateway errors", async () => {
    expect(await client.get("/fail").catch((caught: unknown) => caught)).toMatchObject({ status: 502 });
    const slow = await client.get("/slow").catch((caught: unknown) => caught);
    expect(slow).toBeInstanceOf(UpstreamError);
    expect(slow).toMatchObject({ status: 504 });
  });
});
