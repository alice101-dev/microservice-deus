import { context, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  StackContextManager,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  context.setGlobalContextManager(new StackContextManager().enable());
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }));
});

type Module = typeof import("./interactions");
let interactions: Module;
let parents: Array<string | undefined>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  exporter.reset();
  document.body.innerHTML = "";
  parents = [];
  window.fetch = vi.fn(async () => {
    parents.push(trace.getActiveSpan()?.spanContext().spanId);
    return new Response("{}");
  }) as unknown as typeof fetch;
  interactions = await import("./interactions");
});

afterEach(() => {
  vi.useRealTimers();
});

const settle = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("elementName", () => {
  test("prefers the accessible label, collapses whitespace and stays short", () => {
    document.body.innerHTML = `
      <button aria-label="Tutup menu">×</button>
      <a href="/sales">  Penjualan
         baru </a>
      <button>${"x".repeat(200)}</button>`;
    const [close, link, long] = [...document.querySelectorAll("button, a")] as Element[];
    expect(interactions.elementName(close as Element)).toBe("Tutup menu");
    expect(interactions.elementName(link as Element)).toBe("Penjualan baru");
    expect(interactions.elementName(long as Element)).toHaveLength(80);
  });

  test("names an input after its label, never after its value", () => {
    document.body.innerHTML = `<label for="agree">Setuju syarat</label><input id="agree" type="checkbox" value="rahasia">`;
    expect(interactions.elementName(document.querySelector("input") as Element)).toBe("Setuju syarat");
  });
});

test("route names drop SvelteKit route groups and keep parameters", () => {
  expect(interactions.routeName("/(app)/sales/[id]")).toBe("/sales/[id]");
  expect(interactions.routeName("/(app)")).toBe("/");
  expect(interactions.routeName(null)).toBeNull();
});

describe("interactions", () => {
  test("a click on a button starts an action, a click on plain text does not", async () => {
    document.body.innerHTML = `<p>teks biasa</p><button><span>Simpan draf</span></button>`;
    interactions.instrumentInteractions(/\/otlp\//);
    await settle(1100);
    exporter.reset();
    document.querySelector("p")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(1100);
    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(["click Simpan draf"]);
    expect(spans[0]?.attributes).toMatchObject({ "ui.action": "click", "ui.element.tag": "button" });
  });

  test("requests started during an action become its children and keep it open", async () => {
    interactions.instrumentInteractions(/\/otlp\//);
    interactions.setUser("user-1");
    const action = interactions.startInteraction("click Terbitkan", { "ui.action": "click" });
    await window.fetch("/api/sales/invoices/1/issue", { method: "POST" });
    await window.fetch("/otlp/v1/traces", { method: "POST" });
    await settle(500);
    await window.fetch("/api/sales/invoices/1");
    await settle(900);
    expect(exporter.getFinishedSpans().some((span) => span.name === "click Terbitkan")).toBe(false);
    await settle(200);
    const ended = exporter.getFinishedSpans().find((span) => span.name === "click Terbitkan");
    expect(ended?.attributes["user.id"]).toBe("user-1");
    expect(parents).toEqual([action.spanContext().spanId, undefined, action.spanContext().spanId]);
  });

  test("a navigation ends the previous action and names itself after the route", async () => {
    interactions.instrumentInteractions(/\/otlp\//);
    interactions.startInteraction("click Penjualan", { "ui.action": "click" });
    interactions.startNavigation("link", "/(app)", "/(app)/sales");
    await settle(1100);
    const names = exporter.getFinishedSpans().map((span) => span.name);
    expect(names).toContain("click Penjualan");
    expect(names).toContain("navigation /sales");
  });
});
