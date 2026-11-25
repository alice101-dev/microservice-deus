import { afterEach, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { Profile } from "pprof-format";
import { type CpuProfile, samplingPeriodNanos, startProfiler, toPprof } from "../src/profiling";
import { startTestTelemetry } from "../src/testing";

function frame(functionName: string, lineNumber = 0, url = "file:///app/services/ledger/src/app.ts") {
  return { functionName, url, lineNumber, columnNumber: 0 };
}

function stacks(encoded: Uint8Array) {
  const profile = Profile.decode(encoded);
  const strings = profile.stringTable.strings;
  const functions = new Map(profile.function.map((fn) => [Number(fn.id), strings[Number(fn.name)]]));
  const locations = new Map(
    profile.location.map((location) => [Number(location.id), functions.get(Number(location.line[0]?.functionId))]),
  );
  return {
    profile,
    strings,
    samples: profile.sample.map((sample) => ({
      stack: sample.locationId.map((id) => locations.get(Number(id))).join(";"),
      values: sample.value.map(Number),
    })),
  };
}

const cpuProfile: CpuProfile = {
  nodes: [
    { id: 1, callFrame: frame("(root)", -1), children: [2] },
    { id: 2, callFrame: frame("handler", 10), children: [3, 4] },
    { id: 3, callFrame: frame("sortRows", 20) },
    {
      id: 4,
      callFrame: frame(
        "",
        30,
        "file:///app/node_modules/.bun/drizzle-orm@0.45.4+bf1e/node_modules/drizzle-orm/sql/sql.js",
      ),
    },
  ],
  samples: [3, 3, 4, 2, 1],
};

describe("toPprof", () => {
  test("builds leaf-first stacks without the root frame and counts CPU time per stack", () => {
    const encoded = toPprof(cpuProfile, { periodNanos: 10_000_000, startMs: 1_000, endMs: 16_000 });
    const { profile, strings, samples } = stacks(encoded);

    expect(samples).toEqual([
      { stack: "sortRows;handler", values: [2, 20_000_000] },
      { stack: "(anonymous) drizzle-orm/sql/sql.js:31;handler", values: [1, 10_000_000] },
      { stack: "handler", values: [1, 10_000_000] },
    ]);
    expect(profile.sampleType.map((type) => `${strings[Number(type.type)]}/${strings[Number(type.unit)]}`)).toEqual([
      "samples/count",
      "cpu/nanoseconds",
    ]);
    expect(Number(profile.period)).toBe(10_000_000);
    expect(Number(profile.timeNanos)).toBe(1_000_000_000);
    expect(Number(profile.durationNanos)).toBe(15_000_000_000);
    expect(strings).toContain("/app/services/ledger/src/app.ts");
  });
});

describe("samplingPeriodNanos", () => {
  test("uses the median gap between consecutive samples, ignoring gaps that span idle time", () => {
    const profile = { ...cpuProfile, timeDeltas: [12_100, 12_300, 70_000, 12_200, 13_000, 250_000] };
    expect(samplingPeriodNanos(profile, 10_000_000)).toBe(12_300_000);
  });

  test("falls back to the configured interval without consecutive samples", () => {
    expect(samplingPeriodNanos({ ...cpuProfile, timeDeltas: [90_000] }, 10_000_000)).toBe(10_000_000);
    expect(samplingPeriodNanos(cpuProfile, 10_000_000)).toBe(10_000_000);
  });
});

describe("startProfiler", () => {
  let cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const fn of cleanup) await fn();
    cleanup = [];
  });

  function busy(ms: number) {
    let value = 0;
    const end = Date.now() + ms;
    while (Date.now() < end) value += Math.sqrt(value + 1);
    return value;
  }

  test("pushes a gzipped pprof profile labelled with the service", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const profiler = startProfiler({
      endpoint: "http://pyroscope:4040/",
      labels: { service_name: "ledger", service_namespace: "deus", service_version: "" },
      uploadIntervalMs: 60_000,
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, body: String(init.body) });
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    cleanup.push(() => profiler.shutdown());

    await profiler.flush();
    busy(100);
    await profiler.flush();

    const last = requests.at(-1);
    expect(last?.url).toBe("http://pyroscope:4040/push.v1.PusherService/Push");
    const series = JSON.parse(last?.body ?? "{}").series[0];
    expect(series.labels).toEqual([
      { name: "__name__", value: "process_cpu" },
      { name: "service_name", value: "ledger" },
      { name: "service_namespace", value: "deus" },
    ]);
    const profile = Profile.decode(gunzipSync(Buffer.from(series.samples[0].rawProfile, "base64")));
    expect(profile.sample.length).toBeGreaterThan(0);
    expect(profile.stringTable.strings).toContain("busy");
  });

  test("warns once while the profile store is unreachable", async () => {
    const { telemetry, logs } = startTestTelemetry("profiled");
    cleanup.push(() => telemetry.shutdown());
    const profiler = startProfiler({
      endpoint: "http://pyroscope:4040",
      labels: { service_name: "profiled" },
      uploadIntervalMs: 60_000,
      fetch: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    cleanup.unshift(() => profiler.shutdown());

    await profiler.flush();
    busy(50);
    await profiler.flush();
    busy(50);
    await profiler.flush();

    const records = logs
      .getFinishedLogRecords()
      .filter((record) => record.instrumentationScope.name === "@deus/telemetry");
    expect(records.map((record) => record.severityText)).toEqual(["WARN"]);
    expect(records[0]?.attributes["exception.message"]).toBe("connect ECONNREFUSED");
  });
});
