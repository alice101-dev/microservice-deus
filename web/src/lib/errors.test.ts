import { logs } from "@opentelemetry/api";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { call } from "./api.ts";
import { ApiError, messageOf, reportError } from "./errors.ts";

const exporter = new InMemoryLogRecordExporter();

beforeAll(() => {
  logs.setGlobalLoggerProvider(new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] }));
});
afterEach(() => {
  exporter.reset();
  vi.restoreAllMocks();
});

const problem = (status: number, extra: Record<string, unknown> = {}) => ({
  type: "urn:deus:error:x",
  title: "x",
  status,
  code: "unprocessable",
  detail: "Debits and credits must balance",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  ...extra,
});

describe("error capture", () => {
  test("logs unexpected errors as ERROR with the stack", () => {
    reportError(new TypeError("cannot read properties of undefined"), { "ui.action": "save" });
    const [record] = exporter.getFinishedLogRecords();
    expect(record?.severityText).toBe("ERROR");
    expect(record?.body).toBe("unexpected error");
    expect(record?.attributes).toMatchObject({ "ui.action": "save", "exception.type": "TypeError" });
    expect(String(record?.attributes["exception.stacktrace"])).toContain("TypeError");
  });

  test("logs rejected requests as WARN with the upstream trace id", () => {
    reportError(new ApiError(422, problem(422), "/api/ledger/journals"));
    const [record] = exporter.getFinishedLogRecords();
    expect(record?.severityText).toBe("WARN");
    expect(record?.attributes).toMatchObject({
      "http.response.status_code": 422,
      "url.path": "/api/ledger/journals",
      "upstream.trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    });
  });

  test("turns problem documents into readable messages", () => {
    expect(messageOf(new ApiError(422, problem(422), "/x"))).toBe("Debits and credits must balance");
    expect(messageOf(new ApiError(502, problem(502), "/x"))).toContain("gangguan");
    expect(
      messageOf(new ApiError(400, problem(400, { errors: [{ path: "/lines/0/quantity", message: "bad" }] }), "/x")),
    ).toBe("Data tidak valid: lines/0/quantity");
    expect(messageOf(new TypeError("Failed to fetch"))).toContain("koneksi");
  });

  test("call() throws an ApiError carrying the problem document", async () => {
    const response = new Response(null, { status: 422 });
    Object.defineProperty(response, "url", { value: "http://localhost/api/sales/invoices" });
    const failed = call(Promise.resolve({ data: null, error: { status: 422, value: problem(422) }, response }));
    await expect(failed).rejects.toMatchObject({
      status: 422,
      path: "/api/sales/invoices",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    });
    await expect(call(Promise.resolve({ data: { ok: true }, error: null, response }))).resolves.toEqual({ ok: true });
  });
});
