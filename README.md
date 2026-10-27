# microservice-deus

Accounting and finance SaaS (bookkeeping and automatic financial reports) built as Bun microservices. This
repository holds the code and the deploy values of every service; the platform repository
[k8s-victoria-observability](https://github.com/alice101-dev/k8s-victoria-observability) owns the cluster, the
Argo CD objects that deploy these services and the observability stack they report to.

```text
microservice-deus/
├── packages/           # shared code, imported as @deus/<name>
│   ├── config/         # environment variables validated with TypeBox
│   ├── telemetry/      # OpenTelemetry SDK: traces, metrics and logs over OTLP
│   ├── logger/         # structured logs as OpenTelemetry log records
│   ├── errors/         # application errors and RFC 9457 problem documents
│   └── http/           # Elysia service factory: OpenAPI, tracing, errors, health, graceful shutdown
├── services/<name>/
│   ├── src/            # index.ts starts the service, app.ts builds it
│   ├── test/
│   └── deploy/         # values.yaml and values-<env>.yaml for charts/service
├── charts/service/     # one Helm chart for every service
├── Dockerfile          # bundles one service (SERVICE build argument) into a distroless Bun image
└── Makefile
```

## Stack

| Concern         | Choice                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime         | Bun 1.4                                                                                                                                               |
| Web framework   | Elysia 1.4 with `@elysia/openapi` (spec at `/openapi`, JSON at `/openapi/json`)                                                                       |
| Validation      | TypeBox (`t` from Elysia)                                                                                                                             |
| Telemetry       | OpenTelemetry JS 3.0 (traces, metrics, logs over OTLP/HTTP protobuf) and `@elysia/opentelemetry` for request spans and `http.server.request.duration` |
| Lint and format | Biome                                                                                                                                                 |
| Types           | TypeScript 7 (`tsc --noEmit`)                                                                                                                         |
| Tests           | `bun test`                                                                                                                                            |
| Git hooks       | lefthook: gitleaks, Biome and Squawk before a commit; typecheck and tests before a push                                                               |

## Telemetry contract

Every service sends all three signals to the OpenTelemetry Collector of the platform
(`OTEL_EXPORTER_OTLP_ENDPOINT`, set by the chart). Nothing is scraped and nothing is written to stdout in the
cluster; the collector adds the Kubernetes attributes, masks credentials and routes each signal to its store.

- **Resource**: `service.name`, `service.version` (the image tag), `service.namespace` (`deus`) and
  `deployment.environment.name`.
- **Traces**: one server span per request (`http.route`, `http.request.method`, `http.response.status_code`),
  continuing the W3C `traceparent` of the caller, so a request is one trace from the gateway to the database.
- **Logs**: `createLogger` emits OpenTelemetry log records; every record carries the `trace_id` and `span_id` of
  the active span. Errors add `exception.type`, `exception.message`, `exception.stacktrace` and `exception.cause`.
- **Metrics**: `http.server.request.duration` (seconds) per route and status, `process.memory.usage`,
  `process.runtime.heap.used` and `process.cpu.time`. VictoriaMetrics stores them as
  `http_server_request_duration_seconds_*`, `process_memory_usage_bytes`, ... with labels such as `service_name`.

## Errors

Handlers throw the classes of `@deus/errors` (`NotFoundError`, `ConflictError`, ...). The service answers every
failure with `application/problem+json`: `type`, `title`, `status`, `code`, `detail`, `instance`, `traceId` and, for
schema violations, `errors` with one entry per invalid field. Every failure is logged: 4xx as WARN, 5xx as ERROR
with the stack trace. Unexpected errors never expose their message to the client. Uncaught exceptions are logged
before the process exits; unhandled rejections are logged.

## Health and shutdown

`/health/live` answers while the process runs; `/health/ready` runs the service's readiness checks. On SIGTERM the
service reports not ready for `SHUTDOWN_DRAIN_MS` so the gateway stops sending requests, stops the server, flushes
telemetry for at most `SHUTDOWN_FLUSH_MS` and exits.

## Getting started

```bash
brew install oven-sh/bun/bun gitleaks
bun install
cp .env.example .env
make check
```

`make check` runs Biome, the type check, the tests and renders the chart of every service.

Run a service locally against a local collector, or without one:

```bash
SERVICE_NAME=identity LOG_STDOUT=true bun services/identity/src/index.ts
```

## Releasing

Images are built locally for now and pushed to Artifact Registry (`<region>-docker.pkg.dev/<project>/<env>-deus`);
the tag is the commit, so the working tree must be clean.

```bash
make auth
make release
git commit -am "release <tag>" && git push
```

`make release` builds and pushes every service, then writes the tag into `services/*/deploy/values-staging.yaml`.
Argo CD (ApplicationSet `apps` of the platform repository) deploys each `services/<name>/deploy` folder with
`charts/service` into the namespace `<env>-deus` (`staging-deus`); the registry comes from the cluster, never from this public repository.

## Adding a service

1. `services/<name>/package.json` (`@deus/<name>`), `src/app.ts` with `createService(...).group("/api/<name>", ...)`
   and `src/index.ts` like the existing services.
2. `services/<name>/deploy/values.yaml` with `image.repository: <name>` and, to publish it through the gateway,
   `route.enabled: true` and `route.pathPrefix: /api/<name>`.
3. `make check`, commit, `make release`.

## License

[MIT](LICENSE)
