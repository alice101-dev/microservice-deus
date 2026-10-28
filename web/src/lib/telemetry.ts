import { type Attributes, context, logs, propagation, SeverityNumber, trace } from "@opentelemetry/api";
import { CompositePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, StackContextManager, TracerProvider } from "@opentelemetry/sdk-trace";

export type LogLevel = "info" | "warn" | "error";

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

let started = false;
let providers: Array<{ forceFlush(): Promise<void> }> = [];

export function startTelemetry(options: { version: string; environment: string; endpoint?: string }) {
  if (started) return;
  started = true;
  const endpoint = options.endpoint ?? "/otlp/v1";
  const resource = resourceFromAttributes({
    "service.name": "dashboard",
    "service.version": options.version,
    "service.namespace": "deus",
    "deployment.environment.name": options.environment,
  });
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${endpoint}/traces` }) })],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${endpoint}/logs` }) })],
  });
  context.setGlobalContextManager(new StackContextManager().enable());
  propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator()] }));
  trace.setGlobalTracerProvider(tracerProvider);
  logs.setGlobalLoggerProvider(loggerProvider);
  registerInstrumentations({
    instrumentations: [new FetchInstrumentation({ ignoreUrls: [/\/otlp\//], clearTimingResources: true })],
  });
  providers = [tracerProvider, loggerProvider];
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush();
  });
}

export async function flush() {
  await Promise.allSettled(providers.map((provider) => provider.forceFlush()));
}

export function errorAttributes(error: unknown): Attributes {
  if (!(error instanceof Error)) return error === undefined ? {} : { "exception.message": String(error) };
  return {
    "exception.type": error.name,
    "exception.message": error.message,
    ...(error.stack ? { "exception.stacktrace": error.stack } : {}),
    ...(error.cause instanceof Error ? { "exception.cause": `${error.cause.name}: ${error.cause.message}` } : {}),
  };
}

export function log(level: LogLevel, message: string, attributes: Attributes = {}, error?: unknown) {
  logs.getLogger("@deus/web").emit({
    severityNumber: SEVERITY[level],
    severityText: level.toUpperCase(),
    body: message,
    attributes: {
      "url.path": typeof location === "undefined" ? undefined : location.pathname,
      ...attributes,
      ...errorAttributes(error),
    },
  });
}
