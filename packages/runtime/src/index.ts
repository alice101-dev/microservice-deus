import { join } from "node:path";
import {
  createServiceVerifier,
  createVerifier,
  kubernetesKeys,
  type ServiceVerifier,
  serviceTokenSource,
  type Verifier,
} from "@deus/auth";
import { type Cache, createCache } from "@deus/cache";
import { type BaseConfig, CacheConfig, DatabaseConfig, loadConfig } from "@deus/config";
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
  POD_NAMESPACE: Type.String({ default: "" }),
  KUBERNETES_API_URL: Type.String({ default: "https://kubernetes.default.svc" }),
  SERVICE_IDENTITY_DIR: Type.String({ default: "/var/run/secrets/deus" }),
};

const ServiceConfig = { ...DatabaseConfig, ...AuthConfig, ...CacheConfig };
const ServiceSchema = Type.Object(ServiceConfig);

export type ServiceConfig<P extends TProperties> = BaseConfig & Static<typeof ServiceSchema> & Static<TObject<P>>;

export interface ServiceContext<P extends TProperties, S extends Record<string, unknown>> {
  config: ServiceConfig<P>;
  logger: Logger;
  telemetry: Telemetry;
  db: Database<S>;
  cache: Cache;
  verify: Verifier;
  verifyService: ServiceVerifier;
  serviceToken: () => Promise<string>;
  readiness: Array<() => Promise<void>>;
  onShutdown: (hook: () => Promise<void> | void) => void;
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
  const identity = config.SERVICE_IDENTITY_DIR;
  const kubernetes = kubernetesKeys({
    apiUrl: config.KUBERNETES_API_URL,
    tokenFile: join(identity, "kube/token"),
    caFile: join(identity, "kube/ca.crt"),
  });
  const cache = createCache({ url: config.REDIS_URL, prefix: config.SERVICE_NAME, logger });
  const shutdownHooks: Array<() => Promise<void> | void> = [];
  const app = options.build({
    config,
    logger,
    telemetry,
    db: createDatabase(pool, options.schema),
    cache,
    verify,
    verifyService: createServiceVerifier({ ...kubernetes, namespace: config.POD_NAMESPACE }),
    serviceToken: serviceTokenSource(join(identity, "service/token")),
    readiness: [readiness(pool)],
    onShutdown: (hook) => {
      shutdownHooks.push(hook);
    },
  });
  serve(app, {
    config,
    logger,
    telemetry,
    onShutdown: async () => {
      for (const hook of shutdownHooks) await hook();
      cache.close();
      await pool.end();
    },
  });
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
