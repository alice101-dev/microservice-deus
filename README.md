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
│   ├── http/           # Elysia service factory (OpenAPI, tracing, errors, health, shutdown) and the HTTP client
│   ├── db/             # PostgreSQL pool with spans and metrics, Drizzle, tenant transactions, migration runner
│   ├── auth/           # JWT verification against the identity JWKS and the authenticated principal
│   ├── clients/        # typed clients of the /internal endpoints of other services
│   ├── money/          # IDR amounts as decimal strings and integer cents
│   ├── outbox/         # transactional outbox: events written with the data, delivered at least once
│   └── runtime/        # startService and runMigrations: config, telemetry, logger, database and verifier wiring
├── services/<name>/
│   ├── src/            # index.ts starts the service, app.ts builds it
│   ├── test/
│   └── deploy/         # values.yaml and values-<env>.yaml for charts/service
├── web/                # SvelteKit SPA (src/), Bun static server (server/), browser journey (e2e/)
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

## Services

| Service        | Routes              | Owns                                                                                                                                                  |
| -------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`     | `/api/identity`     | users, sessions and organizations (Better Auth); issues the JWT and serves its JWKS                                                                   |
| `organization` | `/api/organization` | the company profile of an organization: legal name, NPWP, address, currency, fiscal year                                                              |
| `accounts`     | `/api/accounts`     | the chart of accounts, with a default chart for Indonesian SMEs                                                                                       |
| `ledger`       | `/api/ledger`       | journals (draft, posted, reversal), closed periods and the trial balance                                                                              |
| `contacts`     | `/api/contacts`     | customers and vendors: NPWP, payment terms                                                                                                            |
| `products`     | `/api/products`     | goods and services: SKU, prices, VAT rate, default revenue and expense accounts                                                                       |
| `sales`        | `/api/sales`        | invoices: draft, issue (number `INV/<year>/<n>`, journal Dr receivable / Cr revenue and VAT output through the outbox), void (reversal)               |
| `purchases`    | `/api/purchases`    | vendor bills: draft, approve (number `BILL/<year>/<n>`, journal Dr expense or inventory and VAT input / Cr payable), void                             |
| `payments`     | `/api/payments`     | customer receipts (`RCV/...`) and vendor payments (`PAY/...`) allocated to invoices or bills; journal Dr cash / Cr receivable or Dr payable / Cr cash |
| `reporting`    | `/api/reporting`    | income statement (laba rugi), balance sheet (neraca) with unclosed earnings, statement snapshots                                                      |
| `tax`          | `/api/tax`          | monthly VAT return (SPT Masa PPN) from the ledger; filing posts Dr VAT output / Cr VAT input and tax payable                                          |
| `banking`      | `/api/banking`      | bank accounts, statement import with de-duplication, matching to payments, fee postings, reconciliation                                               |
| `notification` | `/api/notification` | email (SMTP; Mailpit in staging) with the invoice PDF, queued by other services through `/internal/notification/messages`                             |

The other services call each other over HTTP with `createClient` from `@deus/http`: the client continues the trace,
records `http.client.request.duration` and turns failures into 502 or 504.

## Service identity

Calls between services do not carry a user token. Each pod gets a projected service account token with the audience
`deus-services` (`/var/run/secrets/deus/service/token`, rotated by the kubelet). The receiver verifies it against the
cluster's OIDC keys (`/openid/v1/jwks`, readable by every service account), accepts only service accounts of its own
namespace, and checks the caller against an allow-list (`serviceAuthentication` from `@deus/auth`). These endpoints
live under `/internal/<service>`, which the gateway does not route, and take the organization explicitly:

| Endpoint                                                                      | Callers                                                                                             |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /internal/accounts/lookup`                                               | ledger, sales, purchases, payments, banking, tax, reporting                                         |
| `POST /internal/ledger/journals`                                              | sales, purchases, payments, banking, tax (journal `source`)                                         |
| `POST /internal/ledger/journals/reverse`                                      | sales, purchases, payments, banking, tax (reverses the caller's journal for a source document once) |
| `GET /internal/contacts/lookup`, `GET /internal/products/lookup`              | sales, purchases, payments, ...                                                                     |
| `GET /internal/sales/invoices/lookup`, `GET /internal/purchases/bills/lookup` | payments, reporting, notification                                                                   |
| `POST /internal/{sales,purchases}/allocations[/reverse]`                      | payments (idempotent per allocation id; refuses overpayment)                                        |

## Outbox

A service that must tell another one about a change writes an event into its own `outbox` table in the same
transaction as the change (`enqueue` from `@deus/outbox`), so the change and the event commit or roll back together.
The relay of every replica claims due events with a lease (`FOR UPDATE SKIP LOCKED`), calls the handler outside the
transaction and marks the event delivered. Delivery is at least once: the event id is the `Idempotency-Key` of the
call, so the receiver applies it once. Failures retry with exponential backoff (up to 5 minutes); a 400, 404 or 422
answer or the last attempt marks the event dead and logs it as an error. The delivery span continues the trace of
the request that wrote the event. Metrics: `outbox.events` (topic, outcome), `outbox.delivery.delay`,
`outbox.backlog` (pending, dead). Delivered events are purged after 7 days.

## Authentication

`identity` signs a short-lived JWT (EdDSA, issuer `deus-identity`, audience `deus`, claims `sub`, `email` and `org`,
the active organization) at `/api/identity/auth/token`. Every other service verifies it against the JWKS at
`/api/identity/auth/jwks` (`authentication` from `@deus/auth`) and uses `org` as the tenant of every query.

## Ledger rules

- Every journal has at least two lines, each with either a debit or a credit, and balances to the cent; amounts are
  decimal strings with at most two fraction digits, computed as integer cents.
- Only accounts without sub-accounts take postings; header accounts (`postable: false`) only group their children.
- A posted journal and its lines cannot change: triggers reject the update or delete in the database. A mistake is
  corrected with a reversal (`POST /journals/:id/reverse`), once per journal.
- `POST /journals` with an `Idempotency-Key` header returns the first journal for the same key and body, and 422 for
  the same key with another body.
- A payment is fully allocated to issued invoices or approved bills of its contact. The ledger journal and the
  allocations travel as two outbox events; voiding a payment reverses both, and the reversal of the allocations waits
  until they were applied.
- Closing a period (`POST /periods/YYYY-MM/close`) stops posting into it; the close and the posts of a period take the
  same advisory lock.

## Web

`web/` is a SvelteKit 3 single-page app (adapter-static, no server-side rendering or server routes) served at `/`
through the same gateway as the API, so the browser talks to one origin.

- **API clients**: Eden Treaty clients typed from each service's `createApp` (`@deus/<service>/app`, type-only
  imports), so a backend change that breaks the UI fails `svelte-check`. Requests carry the Better Auth JWT, which is
  refreshed a minute before it expires and once after a 401. Response dates stay strings (`parseDate: false`).
- **Money**: amounts are computed with `@deus/money`, so invoice previews match the backend to the cent.
- **Errors and telemetry**: unhandled errors, rejected promises, SvelteKit load errors and failed requests are
  logged as OpenTelemetry log records (`service.name=web`); fetch spans continue into the services, so one trace
  runs from the click to the database. The browser sends OTLP to `/otlp/v1/{traces,logs}` on the gateway; the
  platform collector stamps `service.name=web` on everything that arrives there.
- **Serving**: `web/server` (Bun, `createService`) serves hashed assets as immutable, everything else `no-cache`,
  falls back to `index.html` for routes, and sets security headers; the page carries a hash-based CSP.
- **Checks**: `make web` runs `svelte-check`, Vitest (jsdom, Testing Library) and the build. `make e2e` walks a
  browser through registration, onboarding, a customer, a product, an invoice, its payment and the reports against
  `BASE_URL` (default `http://localhost:8080`); `HEADED=1` shows the browser. SvelteKit and `svelte-check` need the
  TypeScript 6 API (`typescript`); the workspace typecheck uses TypeScript 7 (`typescript-native`).

## Database

Each service owns one database in the CloudNativePG cluster `deus-db` (provisioned by the platform repository) with
two roles: `<service>_migrator` owns the schema and runs the migrations, `<service>_app` only reads and writes data,
so row level security applies to it. Set `database.enabled: true` in the service's deploy values; the chart passes
`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` from the basic-auth Secrets `deus-db-<service>-app` and
`deus-db-<service>-migrator`.

- **Queries**: `createPool` (node-postgres) sets `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`
  and `application_name`, records a client span per query (`db.query.text`, `db.operation.name`, `db.namespace`) and
  the metrics `db.client.operation.duration`, `db.client.connection.count` and `db.client.connection.pending_requests`.
- **Tenants**: tenant tables carry `organization_id` and a policy on `current_setting('app.organization_id')`;
  `withTenant(db, organizationId, tx => ...)` runs the work in a transaction with that setting, so a query without a
  tenant sees no rows.
- **Migrations**: `drizzle-kit generate` writes versioned SQL into `services/<service>/migrations` (never
  `drizzle-kit push`); hand-written changes such as grants use `drizzle-kit generate --custom`. Migrations are
  forward only and must work with the previous release (expand, then contract). The image carries them, and an
  Argo CD PreSync Job applies them as the migrator before the new version rolls out: in file order, under an
  advisory lock, each file in its own transaction with `lock_timeout` 5s, recorded with its checksum so an applied
  file cannot change. A file with `CREATE INDEX CONCURRENTLY` must hold only that statement and runs outside a
  transaction. The Job is deleted when the sync succeeds (`HookSucceeded`); a failed Job stays for
  inspection until the next sync replaces it (`BeforeHookCreation`). Its logs are in VictoriaLogs either way.
- **Linting**: Squawk checks every migration before a commit (`.squawk.toml`: PostgreSQL 18, files run in a
  transaction; `require-lock-timeout` and `require-statement-timeout` are off because the runner sets both;
  `prefer-bigint-over-int` and `prefer-bigint-over-smallint` are off because identifiers are UUIDs and integer
  columns only hold small bounded values with a CHECK constraint, such as a month).
- `make test-integration` runs the tests against a PostgreSQL 18 container.

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
