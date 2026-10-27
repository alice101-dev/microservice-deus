import { context, logs, type Meter, metrics, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion: string;
  serviceNamespace: string;
  environment: string;
  endpoint: string;
  metricExportIntervalMs?: number;
  spanExporter?: SpanExporter;
  logExporter?: LogRecordExporter;
  metricExporter?: PushMetricExporter;
  synchronous?: boolean;
}

export interface Telemetry {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function startTelemetry(options: TelemetryOptions): Telemetry {
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: options.serviceName,
    [ATTR_SERVICE_VERSION]: options.serviceVersion,
    "service.namespace": options.serviceNamespace,
    "deployment.environment.name": options.environment,
  });

  const spanExporter = options.spanExporter ?? new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
  const logExporter = options.logExporter ?? new OTLPLogExporter({ url: `${endpoint}/v1/logs` });
  const metricExporter = options.metricExporter ?? new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` });

  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [
      options.synchronous
        ? new SimpleSpanProcessor({ exporter: spanExporter })
        : new BatchSpanProcessor({ exporter: spanExporter }),
    ],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      options.synchronous
        ? new SimpleLogRecordProcessor({ exporter: logExporter })
        : new BatchLogRecordProcessor({ exporter: logExporter }),
    ],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: options.metricExportIntervalMs ?? 30000,
      }),
    ],
  });

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
  );
  trace.setGlobalTracerProvider(tracerProvider);
  logs.setGlobalLoggerProvider(loggerProvider);
  metrics.setGlobalMeterProvider(meterProvider);
  registerProcessMetrics(meterProvider.getMeter("@deus/telemetry"));

  const providers = [tracerProvider, loggerProvider, meterProvider];
  return {
    async forceFlush() {
      await Promise.all(providers.map((provider) => provider.forceFlush()));
    },
    async shutdown() {
      await Promise.allSettled(providers.map((provider) => provider.shutdown()));
      trace.disable();
      logs.disable();
      metrics.disable();
      propagation.disable();
      context.disable();
    },
  };
}

function registerProcessMetrics(meter: Meter) {
  meter
    .createObservableGauge("process.memory.usage", { unit: "By", description: "Resident set size of the process" })
    .addCallback((result) => result.observe(process.memoryUsage().rss));
  meter
    .createObservableGauge("process.runtime.heap.used", { unit: "By", description: "JavaScript heap in use" })
    .addCallback((result) => result.observe(process.memoryUsage().heapUsed));
  meter
    .createObservableCounter("process.cpu.time", { unit: "s", description: "CPU time used by the process" })
    .addCallback((result) => {
      const usage = process.cpuUsage();
      result.observe(usage.user / 1e6, { "cpu.mode": "user" });
      result.observe(usage.system / 1e6, { "cpu.mode": "system" });
    });
}
