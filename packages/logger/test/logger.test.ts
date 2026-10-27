import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { SeverityNumber, trace } from "@opentelemetry/api";
import { createLogger } from "../src";

const { telemetry, logs } = startTestTelemetry("logger-test");
afterAll(() => telemetry.shutdown());
beforeEach(() => logs.reset());

describe("createLogger", () => {
  test("emits OpenTelemetry log records correlated with the active span", () => {
    const logger = createLogger({ name: "test" });
    let traceId = "";
    trace.getTracer("test").startActiveSpan("work", (span) => {
      traceId = span.spanContext().traceId;
      logger.info("journal posted", { "journal.id": "j-1", ignored: undefined });
      span.end();
    });
    const [record] = logs.getFinishedLogRecords();
    expect(record?.body).toBe("journal posted");
    expect(record?.severityNumber).toBe(SeverityNumber.INFO);
    expect(record?.attributes).toEqual({ "journal.id": "j-1" });
    expect(record?.spanContext?.traceId).toBe(traceId);
  });

  test("records exceptions with their cause", () => {
    const logger = createLogger({ name: "test" }).child({ component: "outbox" });
    logger.error(
      "delivery failed",
      { attempt: 3 },
      new Error("ledger unavailable", { cause: new TypeError("fetch failed") }),
    );
    const attributes = logs.getFinishedLogRecords()[0]?.attributes ?? {};
    expect(attributes.component).toBe("outbox");
    expect(attributes.attempt).toBe(3);
    expect(attributes["exception.type"]).toBe("Error");
    expect(attributes["exception.message"]).toBe("ledger unavailable");
    expect(attributes["exception.cause"]).toBe("TypeError: fetch failed");
    expect(String(attributes["exception.stacktrace"])).toContain("logger.test.ts");
  });

  test("drops records below the configured level", () => {
    const logger = createLogger({ name: "test", level: "warn" });
    logger.debug("noise");
    logger.info("noise");
    logger.warn("kept");
    expect(logs.getFinishedLogRecords().map((record) => record.body)).toEqual(["kept"]);
  });
});
