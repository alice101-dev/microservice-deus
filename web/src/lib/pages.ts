import { type Attributes, type Context, context, ROOT_CONTEXT, type Span, SpanKind, trace } from "@opentelemetry/api";

const IDLE_MS = 1000;
const MAX_MS = 15_000;

interface Page {
  span: Span;
  context: Context;
  inflight: number;
  lastActivity: Date;
  idle?: ReturnType<typeof setTimeout>;
  max: ReturnType<typeof setTimeout>;
}

let current: Page | undefined;

export function routeName(id: string | null | undefined): string {
  if (!id) return "unknown";
  return id.replace(/\/\([^)]+\)/g, "") || "/";
}

function finish(page: Page | undefined = current) {
  if (!page) return;
  clearTimeout(page.idle);
  clearTimeout(page.max);
  page.span.end(page.lastActivity);
  if (current === page) current = undefined;
}

function scheduleIdle(page: Page) {
  clearTimeout(page.idle);
  if (page.inflight === 0) page.idle = setTimeout(() => finish(page), IDLE_MS);
}

export function startPage(kind: "pageload" | "navigation", route: string, attributes: Attributes = {}) {
  finish();
  const span = trace
    .getTracer("@deus/web")
    .startSpan(
      `${kind} ${route}`,
      { kind: SpanKind.INTERNAL, attributes: { "app.route": route, ...attributes } },
      ROOT_CONTEXT,
    );
  const page: Page = {
    span,
    context: trace.setSpan(ROOT_CONTEXT, span),
    inflight: 0,
    lastActivity: new Date(),
    max: setTimeout(() => finish(page), MAX_MS),
  };
  current = page;
  scheduleIdle(page);
}

export function namePageload(id: string | null | undefined) {
  if (!current) return;
  const route = routeName(id);
  current.span.updateName(`pageload ${route}`);
  current.span.setAttribute("app.route", route);
}

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

export function instrumentPages(ignore: RegExp, route: string) {
  const instrumented = window.fetch;
  window.fetch = function fetchInPage(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const page = current;
    if (!page || ignore.test(requestUrl(input))) return instrumented.call(this, input, init);
    page.inflight++;
    clearTimeout(page.idle);
    const response = context.with(page.context, () => instrumented.call(this, input, init));
    const settle = () => {
      page.inflight--;
      page.lastActivity = new Date();
      if (current === page) scheduleIdle(page);
    };
    response.then(settle, settle);
    return response;
  } as typeof fetch;
  startPage("pageload", route);
}
