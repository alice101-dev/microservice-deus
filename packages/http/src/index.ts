import type { BaseConfig } from "@deus/config";
import { AppError, type Problem, problem, toProblem } from "@deus/errors";
import type { Logger } from "@deus/logger";
import type { Telemetry } from "@deus/telemetry";
import { openapi } from "@elysia/openapi";
import { opentelemetry } from "@elysia/opentelemetry";
import { metrics, trace } from "@opentelemetry/api";
import { Elysia, StatusMap } from "elysia";

export type ReadinessCheck = () => Promise<void> | void;

export interface ServiceOptions {
  config: BaseConfig;
  logger: Logger;
  readiness?: ReadinessCheck[];
  traceRequests?: boolean;
}

export interface ServiceState {
  draining: boolean;
}

const HEALTH = "/health/";
const STARTUP_GRACE_MS = 60_000;
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

function traceId(): string | undefined {
  return trace.getActiveSpan()?.spanContext().traceId;
}

export function createService(options: ServiceOptions) {
  const { config, logger } = options;
  const state: ServiceState = { draining: false };
  const startedAt = Date.now();
  let ready: boolean | undefined;
  const readiness = options.readiness ?? [];
  const duration = metrics.getMeter("@deus/http").createHistogram("http.server.request.duration", {
    unit: "s",
    description: "Duration of HTTP server requests",
    advice: { explicitBucketBoundaries: DURATION_BUCKETS },
  });
  const started = new WeakMap<Request, number>();

  return new Elysia({ name: config.SERVICE_NAME })
    .decorate("logger", logger)
    .state("service", state)
    .onRequest(({ request }) => {
      started.set(request, performance.now());
    })
    .onAfterResponse({ as: "global" }, ({ request, route, set, responseValue }) => {
      const start = started.get(request);
      if (start === undefined || new URL(request.url).pathname.startsWith(HEALTH)) return;
      const status =
        responseValue instanceof Response
          ? responseValue.status
          : typeof set.status === "number"
            ? set.status
            : (StatusMap[set.status as keyof typeof StatusMap] ?? 200);
      duration.record((performance.now() - start) / 1000, {
        "http.request.method": request.method,
        "http.route": route || undefined,
        "http.response.status_code": status,
        ...(status >= 500 ? { "error.type": String(status) } : {}),
      });
    })
    .use(
      opentelemetry({
        serviceName: config.SERVICE_NAME,
        checkIfShouldTrace: (request) =>
          options.traceRequests !== false && !new URL(request.url).pathname.startsWith(HEALTH),
      }),
    )
    .use(
      openapi({
        path: "/openapi",
        exclude: { paths: [`${HEALTH}live`, `${HEALTH}ready`] },
        documentation: { info: { title: config.SERVICE_NAME, version: config.SERVICE_VERSION } },
      }),
    )
    .onError({ as: "global" }, ({ code, error, request, route, set }) => {
      const instance = new URL(request.url).pathname;
      const attributes = { "http.request.method": request.method, "http.route": route, "url.path": instance };
      let body: Problem;
      if (code === "VALIDATION") {
        body = problem(400, "validation", "The request does not match the schema", {
          instance,
          traceId: traceId(),
          errors: error.all.map((issue) => ({ path: issue.path, message: issue.message })),
        });
      } else if (code === "NOT_FOUND") {
        body = problem(404, "route_not_found", `No route for ${request.method} ${instance}`, {
          instance,
          traceId: traceId(),
        });
      } else if (code === "PARSE") {
        body = problem(400, "malformed_body", "The request body cannot be parsed", { instance, traceId: traceId() });
      } else {
        body = toProblem(error, { instance, traceId: traceId() });
      }
      const logAttributes = { ...attributes, "http.response.status_code": body.status, "error.code": body.code };
      if (body.status >= 500) logger.error("request failed", logAttributes, error);
      else if (error instanceof AppError) {
        const cause = error.cause instanceof Error ? error.cause : undefined;
        logger.warn("request rejected", {
          ...logAttributes,
          "exception.message": error.message,
          "exception.cause": cause ? `${cause.name}: ${cause.message}` : undefined,
        });
      } else logger.warn("request rejected", logAttributes, error);
      set.status = body.status;
      set.headers["content-type"] = "application/problem+json";
      return body;
    })
    .get(`${HEALTH}live`, () => ({ status: "ok" }))
    .get(`${HEALTH}ready`, async ({ set }) => {
      if (state.draining) {
        set.status = 503;
        return { status: "draining" };
      }
      try {
        await Promise.all(readiness.map((check) => check()));
        if (ready === false) logger.info("readiness restored");
        ready = true;
        return { status: "ready" };
      } catch (error) {
        const starting = ready === undefined && Date.now() - startedAt < STARTUP_GRACE_MS;
        if (!starting && ready !== false) logger.warn("readiness check failed", {}, error);
        if (!starting) ready = false;
        set.status = 503;
        return { status: "unavailable" };
      }
    });
}

export interface ServeOptions {
  config: BaseConfig;
  logger: Logger;
  telemetry: Telemetry;
  onShutdown?: () => Promise<void> | void;
}

interface Stoppable {
  listen(port: number): unknown;
  stop(closeActiveConnections?: boolean): unknown;
  store: { service: ServiceState };
}

export function serve(app: Stoppable, options: ServeOptions) {
  const { config, logger, telemetry } = options;
  let stopping = false;

  const stop = async (reason: string, exitCode: number) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { reason, "drain.ms": config.SHUTDOWN_DRAIN_MS });
    app.store.service.draining = true;
    await Bun.sleep(config.SHUTDOWN_DRAIN_MS);
    try {
      await app.stop();
      await options.onShutdown?.();
    } catch (error) {
      logger.error("shutdown failed", {}, error);
      exitCode = 1;
    }
    await Promise.race([telemetry.shutdown(), Bun.sleep(config.SHUTDOWN_FLUSH_MS)]);
    process.exit(exitCode);
  };

  process.on("SIGTERM", () => void stop("SIGTERM", 0));
  process.on("SIGINT", () => void stop("SIGINT", 0));
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", {}, error);
    void stop("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled promise rejection", {}, reason);
  });

  app.listen(config.PORT);
  logger.info("listening", { "server.port": config.PORT, "service.version": config.SERVICE_VERSION });
}

export {
  type Client,
  type ClientOptions,
  createClient,
  type RequestOptions,
  UpstreamError,
  urlTemplate,
} from "./client";
