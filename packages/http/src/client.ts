import { AppError } from "@deus/errors";
import { context, metrics, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

export interface ClientOptions {
  name: string;
  baseUrl: string;
  timeoutMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  token?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export class UpstreamError extends AppError {
  constructor(
    readonly upstream: string,
    status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(status, "upstream_failed", message, undefined, options);
  }
}

const ID_SEGMENT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

export function urlTemplate(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
}

function buildUrl(baseUrl: string, path: string, query: RequestOptions["query"]) {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
  }
  return url;
}

export function createClient(options: ClientOptions) {
  const tracer = trace.getTracer("@deus/http");
  const duration = metrics.getMeter("@deus/http").createHistogram("http.client.request.duration", {
    unit: "s",
    description: "Duration of outgoing HTTP requests",
    advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
  });
  const request = async <T>(method: string, path: string, init: RequestOptions = {}): Promise<T> => {
    const url = buildUrl(options.baseUrl, path.replace(/^\//, ""), init.query);
    const attributes = {
      "http.request.method": method,
      "server.address": url.hostname,
      "server.port": Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      "peer.service": options.name,
    };
    const template = urlTemplate(url.pathname);
    return tracer.startActiveSpan(
      `${method} ${template}`,
      { kind: SpanKind.CLIENT, attributes: { ...attributes, "url.full": url.href, "url.template": template } },
      async (span) => {
        const started = performance.now();
        const headers: Record<string, string> = { accept: "application/json", ...init.headers };
        if (init.body !== undefined) headers["content-type"] = "application/json";
        if (init.token) headers.authorization = `Bearer ${init.token}`;
        if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
        propagation.inject(context.active(), headers);
        let status = 0;
        try {
          const response = await fetch(url, {
            method,
            headers,
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
          });
          status = response.status;
          span.setAttribute("http.response.status_code", status);
          const text = await response.text();
          const payload = text ? (JSON.parse(text) as unknown) : undefined;
          if (!response.ok) {
            const problem = (payload ?? {}) as { detail?: string; code?: string };
            if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
            if (status === 401 || status === 403) {
              throw new UpstreamError(options.name, 502, `${options.name} refused this service (${status})`);
            }
            if (status >= 400 && status < 500) {
              throw new AppError(
                status,
                problem.code ?? "upstream_rejected",
                problem.detail ?? `${options.name} rejected the request`,
                payload,
              );
            }
            throw new UpstreamError(options.name, 502, `${options.name} answered ${status}`);
          }
          return payload as T;
        } catch (error) {
          if (error instanceof AppError) throw error;
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
          const timedOut = (error as Error).name === "TimeoutError";
          throw new UpstreamError(options.name, timedOut ? 504 : 502, `${options.name} is unreachable`, {
            cause: error,
          });
        } finally {
          duration.record((performance.now() - started) / 1000, {
            ...attributes,
            ...(status ? { "http.response.status_code": status } : { "error.type": "unreachable" }),
          });
          span.end();
        }
      },
    );
  };
  return {
    get: <T>(path: string, init?: RequestOptions) => request<T>("GET", path, init),
    post: <T>(path: string, init?: RequestOptions) => request<T>("POST", path, init),
    put: <T>(path: string, init?: RequestOptions) => request<T>("PUT", path, init),
    patch: <T>(path: string, init?: RequestOptions) => request<T>("PATCH", path, init),
    delete: <T>(path: string, init?: RequestOptions) => request<T>("DELETE", path, init),
  };
}

export type Client = ReturnType<typeof createClient>;
