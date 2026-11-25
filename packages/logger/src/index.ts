import type { LogLevel } from "@deus/config";
import { type AttributeValue, context, logs, SeverityNumber, trace } from "@opentelemetry/api";

export type LogAttributes = Record<string, AttributeValue | undefined>;

export interface Logger {
  debug(message: string, attributes?: LogAttributes): void;
  info(message: string, attributes?: LogAttributes): void;
  warn(message: string, attributes?: LogAttributes, error?: unknown): void;
  error(message: string, attributes?: LogAttributes, error?: unknown): void;
  child(attributes: LogAttributes): Logger;
}

export interface LoggerOptions {
  name: string;
  level?: LogLevel;
  stdout?: boolean;
  attributes?: LogAttributes;
}

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

export function errorAttributes(error: unknown): LogAttributes {
  if (!(error instanceof Error)) return error === undefined ? {} : { "exception.message": String(error) };
  const cause = error.cause instanceof Error ? error.cause : undefined;
  return {
    "exception.type": error.name,
    "exception.message": error.message,
    "exception.stacktrace": error.stack,
    "exception.cause": cause ? `${cause.name}: ${cause.message}` : undefined,
  };
}

function clean(attributes: LogAttributes): Record<string, AttributeValue> {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)) as Record<
    string,
    AttributeValue
  >;
}

export function createLogger(options: LoggerOptions): Logger {
  const otel = logs.getLogger(options.name);
  const threshold = SEVERITY[options.level ?? "info"];
  const base = options.attributes ?? {};

  const emit = (level: LogLevel, message: string, attributes: LogAttributes = {}, error?: unknown) => {
    const severityNumber = SEVERITY[level];
    if (severityNumber < threshold) return;
    const merged = clean({ ...base, ...attributes, ...errorAttributes(error) });
    const active = context.active();
    otel.emit({
      severityNumber,
      severityText: level.toUpperCase(),
      body: message,
      attributes: merged,
      context: active,
    });
    if (options.stdout) {
      const spanContext = trace.getSpanContext(active);
      const line = {
        time: new Date().toISOString(),
        level,
        logger: options.name,
        msg: message,
        ...(spanContext ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {}),
        ...merged,
      };
      (level === "error" ? process.stderr : process.stdout).write(`${JSON.stringify(line)}\n`);
    }
  };

  return {
    debug: (message, attributes) => emit("debug", message, attributes),
    info: (message, attributes) => emit("info", message, attributes),
    warn: (message, attributes, error) => emit("warn", message, attributes, error),
    error: (message, attributes, error) => emit("error", message, attributes, error),
    child: (attributes) => createLogger({ ...options, attributes: { ...base, ...attributes } }),
  };
}
