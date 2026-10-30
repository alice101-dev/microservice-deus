import { type Attributes, context, logs, propagation, SeverityNumber, type Span, trace } from "@opentelemetry/api";
import { CompositePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, type ReadableSpan, StackContextManager, TracerProvider } from "@opentelemetry/sdk-trace";
import { type Metric, onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals";

export type LogLevel = "info" | "warn" | "error";

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

const UNTRACED = /\/(otlp|_app)\//;
const ID_SEGMENT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

let started = false;
let providers: Array<{ forceFlush(): Promise<void> }> = [];

let page: string | undefined;

export function setPage(url: URL | string) {
  page = urlTemplate(String(url));
}

export function currentPage() {
  return page ?? (typeof location === "undefined" ? undefined : urlTemplate(location.pathname));
}

export function urlTemplate(url: string): string {
  return new URL(url, location.href).pathname
    .split("/")
    .map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
}

function nameRequest(span: Span) {
  const { attributes } = span as unknown as ReadableSpan;
  const url = attributes["url.full"];
  if (typeof url !== "string") return;
  const template = urlTemplate(url);
  span.setAttribute("url.template", template);
  const route = currentPage();
  if (route) span.setAttribute("app.route", route);
  span.updateName(`${attributes["http.request.method"] ?? "GET"} ${template}`);
}

function reportVital(metric: Metric) {
  log("info", "web vital", {
    "web_vital.name": metric.name,
    "web_vital.value": metric.value,
    "web_vital.rating": metric.rating,
    "navigation.type": metric.navigationType,
  });
}

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
    instrumentations: [
      new FetchInstrumentation({ ignoreUrls: [UNTRACED], clearTimingResources: true, requestHook: nameRequest }),
      new DocumentLoadInstrumentation(),
    ],
  });
  for (const subscribe of [onLCP, onINP, onCLS, onFCP, onTTFB]) subscribe(reportVital);
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
      "app.route": currentPage(),
      ...attributes,
      ...errorAttributes(error),
    },
  });
}
