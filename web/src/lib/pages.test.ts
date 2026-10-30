import { context, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  StackContextManager,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  context.setGlobalContextManager(new StackContextManager().enable());
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }));
});

let pages: typeof import("./pages");
let parents: Array<string | undefined>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  exporter.reset();
  parents = [];
  window.fetch = vi.fn((input: RequestInfo | URL) => {
    parents.push(trace.getActiveSpan()?.spanContext().spanId);
    if (!String(input).includes("slow")) return Promise.resolve(new Response("{}"));
    return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("{}")), 300));
  }) as unknown as typeof fetch;
  pages = await import("./pages");
});

afterEach(() => {
  vi.useRealTimers();
});

const settle = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const ms = (duration: [number, number]) => duration[0] * 1000 + duration[1] / 1e6;

test("route names drop SvelteKit route groups and keep parameters", () => {
  expect(pages.routeName("/(app)/sales/[id]")).toBe("/sales/[id]");
  expect(pages.routeName("/(app)")).toBe("/");
  expect(pages.routeName(null)).toBe("unknown");
});

test("the first page load is the root of the requests it makes and is named after its route", async () => {
  pages.instrumentPages(/\/otlp\//, "/contacts");
  pages.namePageload("/(app)/contacts");
  await window.fetch("/api/contacts");
  await window.fetch("/otlp/v1/traces", { method: "POST" });
  await settle(1100);
  const [pageload] = exporter.getFinishedSpans();
  expect(pageload?.name).toBe("pageload /contacts");
  expect(pageload?.parentSpanContext).toBeUndefined();
  expect(parents).toEqual([pageload?.spanContext().spanId, undefined]);
});

test("a navigation ends the previous page and is the root of its own requests", async () => {
  pages.instrumentPages(/\/otlp\//, "/contacts");
  await settle(1100);
  exporter.reset();
  pages.startPage("navigation", "/sales", { "app.route.from": "/contacts" });
  await window.fetch("/api/sales/invoices");
  pages.startPage("navigation", "/payments");
  await settle(1100);
  const names = exporter.getFinishedSpans().map((span) => span.name);
  expect(names).toEqual(["navigation /sales", "navigation /payments"]);
  const [sales] = exporter.getFinishedSpans();
  expect(sales?.parentSpanContext).toBeUndefined();
  expect(parents).toEqual([sales?.spanContext().spanId]);
});

test("a page ends when its last request settled, not when the idle wait ran out", async () => {
  pages.instrumentPages(/\/otlp\//, "/sales");
  await Promise.all([window.fetch("/api/slow"), settle(300)]);
  await settle(1100);
  const [pageload] = exporter.getFinishedSpans();
  expect(ms(pageload?.duration ?? [0, 0])).toBeGreaterThanOrEqual(300);
  expect(ms(pageload?.duration ?? [0, 0])).toBeLessThan(400);
});

test("requests after the page went idle start their own trace", async () => {
  pages.instrumentPages(/\/otlp\//, "/sales");
  await settle(1100);
  await window.fetch("/api/sales/invoices");
  expect(parents).toEqual([undefined]);
});
