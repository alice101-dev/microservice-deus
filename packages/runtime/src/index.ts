import { join } from "node:path";
import { createVerifier, type Verifier } from "@deus/auth";
import { type BaseConfig, DatabaseConfig, loadConfig } from "@deus/config";
import { createDatabase, createPool, type Database, readiness } from "@deus/db";
import { runMigrationJob } from "@deus/db/migrate";
import { serve } from "@deus/http";
import { createLogger, type Logger } from "@deus/logger";
import { startTelemetry, type Telemetry } from "@deus/telemetry";
import { type Static, type TObject, type TProperties, Type } from "@sinclair/typebox";

export const AuthConfig = {
  AUTH_JWKS_URL: Type.String({ default: "http://identity/api/identity/auth/jwks" }),
  AUTH_ISSUER: Type.String({ default: "deus-identity" }),
  AUTH_AUDIENCE: Type.String({ default: "deus" }),
};

const ServiceConfig = { ...DatabaseConfig, ...AuthConfig };
const ServiceSchema = Type.Object(ServiceConfig);

export type ServiceConfig<P extends TProperties> = BaseConfig & Static<typeof ServiceSchema> & Static<TObject<P>>;

export interface ServiceContext<P extends TProperties, S extends Record<string, unknown>> {
  config: ServiceConfig<P>;
  logger: Logger;
  telemetry: Telemetry;
  db: Database<S>;
  verify: Verifier;
  readiness: Array<() => Promise<void>>;
}

function telemetryFor(config: BaseConfig, suffix = "") {
  return startTelemetry({
    serviceName: `${config.SERVICE_NAME}${suffix}`,
    serviceVersion: config.SERVICE_VERSION,
    serviceNamespace: config.SERVICE_NAMESPACE,
    environment: config.DEPLOYMENT_ENVIRONMENT,
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    metricExportIntervalMs: config.OTEL_METRIC_EXPORT_INTERVAL,
  });
}

export function startService<P extends TProperties, S extends Record<string, unknown>>(options: {
  config: P;
  schema: S;
  build: (context: ServiceContext<P, S>) => {
    listen(port: number): unknown;
    stop(): unknown;
    store: { service: { draining: boolean } };
  };
}) {
  const config = loadConfig({ ...ServiceConfig, ...options.config }) as unknown as ServiceConfig<P>;
  const telemetry = telemetryFor(config);
  const logger = createLogger({ name: config.SERVICE_NAME, level: config.LOG_LEVEL, stdout: config.LOG_STDOUT });
  const pool = createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    applicationName: config.SERVICE_NAME,
    maxConnections: config.DB_MAX_CONNECTIONS,
  });
  const verify = createVerifier({
    jwksUrl: config.AUTH_JWKS_URL,
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
  });
  const app = options.build({
    config,
    logger,
    telemetry,
    db: createDatabase(pool, options.schema),
    verify,
    readiness: [readiness(pool)],
  });
  serve(app, { config, logger, telemetry, onShutdown: () => pool.end() });
}

export async function runMigrations(directory = process.env.MIGRATIONS_DIR ?? join(process.cwd(), "migrations")) {
  const config = loadConfig(DatabaseConfig);
  const telemetry = telemetryFor(config, "-migrations");
  await runMigrationJob({
    directory,
    connection: {
      host: config.DB_HOST,
      port: config.DB_PORT,
      database: config.DB_NAME,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
    },
    logger: createLogger({ name: `${config.SERVICE_NAME}-migrations`, stdout: true }),
    flush: () => telemetry.shutdown(),
  });
}
