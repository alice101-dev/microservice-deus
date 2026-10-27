import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { startTelemetry } from "./index";

export function startTestTelemetry(serviceName = "test-service") {
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry = startTelemetry({
    serviceName,
    serviceVersion: "test",
    serviceNamespace: "deus",
    environment: "test",
    endpoint: "http://127.0.0.1:4318",
    spanExporter: spans,
    logExporter: logs,
    metricExporter: metrics,
    synchronous: true,
  });
  return { telemetry, spans, logs, metrics };
}
