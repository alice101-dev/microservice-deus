import { type Attributes, type Context, context, ROOT_CONTEXT, type Span, SpanKind, trace } from "@opentelemetry/api";

const IDLE_MS = 1000;
const MAX_MS = 15_000;
const NAME_LENGTH = 80;
const NESTED_NAVIGATIONS = new Set(["link", "goto", "form"]);
const ID_SEGMENT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;
const INTERACTIVE = [
  "a[href]",
  "button",
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  "summary",
  'input[type="submit"]',
  'input[type="button"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
].join(", ");

interface Interaction {
  span: Span;
  action: unknown;
  children: Span[];
  context: Context;
  inflight: number;
  lastActivity: Date;
  idle?: ReturnType<typeof setTimeout>;
  max: ReturnType<typeof setTimeout>;
}

let current: Interaction | undefined;
let route: string | null = null;
let userId: string | null = null;

export function routeName(id: string | null): string | null {
  if (id === null) return null;
  return id.replace(/\/\([^)]+\)/g, "") || "/";
}

export function setRoute(id: string | null) {
  route = routeName(id);
}

export function currentRoute() {
  return route;
}

export function setUser(id: string | null) {
  userId = id;
}

function finish(interaction: Interaction | undefined = current) {
  if (!interaction) return;
  clearTimeout(interaction.idle);
  clearTimeout(interaction.max);
  for (const child of interaction.children.reverse()) child.end(interaction.lastActivity);
  interaction.span.end(interaction.lastActivity);
  if (current === interaction) current = undefined;
}

function scheduleIdle(interaction: Interaction) {
  clearTimeout(interaction.idle);
  if (interaction.inflight === 0) interaction.idle = setTimeout(() => finish(interaction), IDLE_MS);
}

function startSpan(name: string, attributes: Attributes, parent: Context) {
  return trace.getTracer("@deus/web").startSpan(
    name,
    {
      kind: SpanKind.INTERNAL,
      attributes: { ...(route ? { "app.route": route } : {}), ...(userId ? { "user.id": userId } : {}), ...attributes },
    },
    parent,
  );
}

export function startInteraction(name: string, attributes: Attributes = {}): Span {
  finish();
  const span = startSpan(name, attributes, ROOT_CONTEXT);
  const interaction: Interaction = {
    span,
    action: attributes["ui.action"],
    children: [],
    context: trace.setSpan(ROOT_CONTEXT, span),
    inflight: 0,
    lastActivity: new Date(),
    max: setTimeout(() => finish(interaction), MAX_MS),
  };
  current = interaction;
  scheduleIdle(interaction);
  return span;
}

export function currentInteraction(): Span | undefined {
  return current?.span;
}

export function elementName(element: Element): string {
  const labelled = element.getAttribute("aria-label") ?? element.getAttribute("title");
  const own = element instanceof HTMLInputElement ? element.labels?.[0]?.textContent : element.textContent;
  const text = (labelled || own || "").replace(/\s+/g, " ").trim();
  return text.length > NAME_LENGTH ? `${text.slice(0, NAME_LENGTH - 1)}…` : text;
}

export function recordClick(event: Event) {
  const target = event.target instanceof Element ? event.target.closest(INTERACTIVE) : null;
  if (!target) return;
  const tag = target.tagName.toLowerCase();
  const name = elementName(target) || tag;
  const href = target instanceof HTMLAnchorElement ? new URL(target.href, location.href) : null;
  startInteraction(`click ${name}`, {
    "ui.action": "click",
    "ui.element.tag": tag,
    "ui.element.name": name,
    ...(href && href.origin === location.origin ? { "ui.element.href": href.pathname } : {}),
  });
}

export function startNavigation(type: string, fromId: string | null, toId: string | null) {
  const from = routeName(fromId);
  const to = routeName(toId);
  const name = `navigation ${to ?? "unknown"}`;
  const attributes = {
    "ui.action": "navigation",
    "navigation.type": type,
    "app.route": to ?? "unknown",
    ...(from ? { "app.route.from": from } : {}),
  };
  if (current?.action === "click" && NESTED_NAVIGATIONS.has(type)) {
    const span = startSpan(name, attributes, trace.setSpan(ROOT_CONTEXT, current.span));
    current.children.push(span);
    current.context = trace.setSpan(ROOT_CONTEXT, span);
    current.lastActivity = new Date();
    return;
  }
  startInteraction(name, attributes);
}

export function urlTemplate(url: string): string {
  return new URL(url, location.href).pathname
    .split("/")
    .map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
}

export function nameEntry(toId: string | null) {
  const to = routeName(toId);
  if (!current) return;
  current.span.updateName(`pageload ${to ?? "unknown"}`);
  current.span.setAttribute("app.route", to ?? "unknown");
}

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

export function instrumentInteractions(ignore: RegExp) {
  const instrumented = window.fetch;
  window.fetch = function fetchInInteraction(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const interaction = current;
    if (!interaction || ignore.test(requestUrl(input))) return instrumented.call(this, input, init);
    interaction.inflight++;
    clearTimeout(interaction.idle);
    const response = context.with(interaction.context, () => instrumented.call(this, input, init));
    const settle = () => {
      interaction.inflight--;
      interaction.lastActivity = new Date();
      if (current === interaction) scheduleIdle(interaction);
    };
    response.then(settle, settle);
    return response;
  } as typeof fetch;
  document.addEventListener("click", recordClick, { capture: true });
  startInteraction("pageload", { "ui.action": "pageload" });
}
