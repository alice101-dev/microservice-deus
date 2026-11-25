import { randomUUID } from "node:crypto";
import { Session } from "node:inspector";
import { gzipSync } from "node:zlib";
import { logs, SeverityNumber } from "@opentelemetry/api";
import { Profile, StringTable } from "pprof-format";

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}

export interface CpuProfile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas?: number[];
}

export interface ProfilerOptions {
  endpoint: string;
  labels: Record<string, string>;
  uploadIntervalMs?: number;
  samplingIntervalUs?: number;
  persistentFailureMs?: number;
  fetch?: typeof fetch;
}

export interface Profiler {
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const ROOT_FRAME = "(root)";

function frameFile(url: string) {
  return url.startsWith("file://") ? url.slice("file://".length) : url;
}

function shortFile(file: string) {
  const packagePath = file.lastIndexOf("node_modules/");
  if (packagePath >= 0) return file.slice(packagePath + "node_modules/".length);
  return file.startsWith("/app/") ? file.slice("/app/".length) : file;
}

function functionName(frame: CallFrame, file: string) {
  if (frame.functionName) return frame.functionName;
  return file ? `(anonymous) ${shortFile(file)}:${frame.lineNumber + 1}` : "(anonymous)";
}

export function samplingPeriodNanos(profile: CpuProfile, nominalNanos: number) {
  const consecutive = (profile.timeDeltas ?? [])
    .map((delta) => delta * 1000)
    .filter((delta) => delta > 0 && delta <= 2 * nominalNanos)
    .sort((a, b) => a - b);
  if (consecutive.length === 0) return nominalNanos;
  return Math.round(consecutive[Math.floor(consecutive.length / 2)] as number);
}

export function toPprof(profile: CpuProfile, options: { periodNanos: number; startMs: number; endMs: number }) {
  const strings = new StringTable();
  const parents = new Map<number, number>();
  const byId = new Map<number, ProfileNode>();
  for (const node of profile.nodes) {
    byId.set(node.id, node);
    for (const child of node.children ?? []) parents.set(child, node.id);
  }

  const functionIds = new Map<string, number>();
  const functions: Array<{ id: number; name: number; systemName: number; filename: number; startLine: number }> = [];
  const locationIds = new Map<number, number>();
  const locations: Array<{ id: number; line: Array<{ functionId: number; line: number }> }> = [];

  const locationFor = (node: ProfileNode) => {
    const existing = locationIds.get(node.id);
    if (existing !== undefined) return existing;
    const frame = node.callFrame;
    const file = frameFile(frame.url);
    const name = functionName(frame, file);
    const functionKey = `${name}\u0000${file}\u0000${frame.lineNumber}`;
    let functionId = functionIds.get(functionKey);
    if (functionId === undefined) {
      functionId = functions.length + 1;
      functionIds.set(functionKey, functionId);
      functions.push({
        id: functionId,
        name: strings.dedup(name),
        systemName: strings.dedup(name),
        filename: strings.dedup(file),
        startLine: Math.max(frame.lineNumber + 1, 0),
      });
    }
    const locationId = locations.length + 1;
    locations.push({ id: locationId, line: [{ functionId, line: Math.max(frame.lineNumber + 1, 0) }] });
    locationIds.set(node.id, locationId);
    return locationId;
  };

  const stacks = new Map<number, { locationId: number[]; count: number }>();
  for (const sampleNode of profile.samples) {
    const existing = stacks.get(sampleNode);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const locationId: number[] = [];
    for (let id: number | undefined = sampleNode; id !== undefined; id = parents.get(id)) {
      const node = byId.get(id);
      if (!node || node.callFrame.functionName === ROOT_FRAME) break;
      locationId.push(locationFor(node));
    }
    if (locationId.length > 0) stacks.set(sampleNode, { locationId, count: 1 });
  }

  const cpu = strings.dedup("cpu");
  const nanoseconds = strings.dedup("nanoseconds");
  const pprof = new Profile({
    sampleType: [
      { type: strings.dedup("samples"), unit: strings.dedup("count") },
      { type: cpu, unit: nanoseconds },
    ],
    sample: [...stacks.values()].map((stack) => ({
      locationId: stack.locationId,
      value: [stack.count, stack.count * options.periodNanos],
    })),
    location: locations,
    function: functions,
    stringTable: strings,
    timeNanos: BigInt(Math.round(options.startMs)) * 1_000_000n,
    durationNanos: BigInt(Math.max(Math.round(options.endMs - options.startMs), 0)) * 1_000_000n,
    periodType: { type: cpu, unit: nanoseconds },
    period: options.periodNanos,
  });
  return pprof.encode();
}

function post<T>(session: Session, method: string, params: object = {}) {
  return new Promise<T>((resolve, reject) => {
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result as T)));
  });
}

export function startProfiler(options: ProfilerOptions): Profiler {
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const uploadIntervalMs = options.uploadIntervalMs ?? 15000;
  const samplingIntervalUs = options.samplingIntervalUs ?? 10000;
  const persistentFailureMs = options.persistentFailureMs ?? 300000;
  const send = options.fetch ?? fetch;
  const labels = [
    { name: "__name__", value: "process_cpu" },
    ...Object.entries(options.labels)
      .filter(([, value]) => value !== "")
      .map(([name, value]) => ({ name, value })),
  ];
  const logger = logs.getLogger("@deus/telemetry");
  const session = new Session();
  session.connect();

  let windowStart = Date.now();
  let failingSince: number | undefined;
  let reportedError = false;
  let stopped = false;

  const report = (severityNumber: SeverityNumber, severityText: string, body: string, error: unknown) => {
    logger.emit({
      severityNumber,
      severityText,
      body,
      attributes: {
        "server.address": endpoint,
        "exception.message": error instanceof Error ? error.message : String(error),
      },
    });
  };

  const upload = async (profile: CpuProfile, startMs: number, endMs: number) => {
    if (profile.samples.length === 0) return;
    const periodNanos = samplingPeriodNanos(profile, samplingIntervalUs * 1000);
    const rawProfile = gzipSync(toPprof(profile, { periodNanos, startMs, endMs }));
    try {
      const response = await send(`${endpoint}/push.v1.PusherService/Push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          series: [{ labels, samples: [{ ID: randomUUID(), rawProfile: rawProfile.toString("base64") }] }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      if (failingSince !== undefined) {
        logger.emit({
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
          body: "profile upload recovered",
          attributes: { "server.address": endpoint },
        });
      }
      failingSince = undefined;
      reportedError = false;
    } catch (error) {
      const now = Date.now();
      if (failingSince === undefined) {
        failingSince = now;
        report(SeverityNumber.WARN, "WARN", "profile upload failed, retrying with the next profile", error);
      } else if (!reportedError && now - failingSince >= persistentFailureMs) {
        reportedError = true;
        report(SeverityNumber.ERROR, "ERROR", "profile upload has been failing", error);
      }
    }
  };

  const rotate = async (restart: boolean) => {
    const { profile } = await post<{ profile: CpuProfile }>(session, "Profiler.stop");
    const startMs = windowStart;
    const endMs = Date.now();
    windowStart = endMs;
    if (restart) await post(session, "Profiler.start");
    await upload(profile, startMs, endMs);
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };

  let pending: Promise<void> = post(session, "Profiler.enable")
    .then(() => post(session, "Profiler.setSamplingInterval", { interval: samplingIntervalUs }))
    .then(() => post(session, "Profiler.start"))
    .then(() => {
      windowStart = Date.now();
    })
    .catch((error) => {
      stop();
      session.disconnect();
      report(SeverityNumber.WARN, "WARN", "CPU profiler unavailable, profiling disabled", error);
    });

  const tick = () => {
    if (stopped) return pending;
    pending = pending
      .then(() => rotate(true))
      .catch((error) => {
        stop();
        session.disconnect();
        report(SeverityNumber.WARN, "WARN", "CPU profiler failed, profiling disabled", error);
      });
    return pending;
  };
  timer = setInterval(tick, uploadIntervalMs);
  timer.unref();

  return {
    flush: () => tick(),
    async shutdown() {
      if (stopped) return pending;
      stop();
      await pending;
      await rotate(false).catch(() => undefined);
      session.disconnect();
    },
  };
}
