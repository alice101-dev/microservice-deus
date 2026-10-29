import { createCache } from "@deus/cache";
import { createDatabase, createPool, readiness } from "@deus/db";
import { serve } from "@deus/http";
import { createLogger } from "@deus/logger";
import { startTelemetry } from "@deus/telemetry";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadIdentityConfig } from "./config";
import { schema } from "./schema";

const config = loadIdentityConfig();
const telemetry = startTelemetry({
  serviceName: config.SERVICE_NAME,
  serviceVersion: config.SERVICE_VERSION,
  serviceNamespace: config.SERVICE_NAMESPACE,
  environment: config.DEPLOYMENT_ENVIRONMENT,
  endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  metricExportIntervalMs: config.OTEL_METRIC_EXPORT_INTERVAL,
});
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
const cache = createCache({ url: config.REDIS_URL, prefix: config.SERVICE_NAME, logger });
const auth = createAuth(
  {
    baseURL: config.AUTH_BASE_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: config.AUTH_TRUSTED_ORIGINS.split(",").filter(Boolean),
    issuer: config.AUTH_ISSUER,
    logger,
    storage: cache,
  },
  createDatabase(pool, schema),
  schema,
);

serve(createApp(config, logger, auth, [readiness(pool)]), {
  config,
  logger,
  telemetry,
  onShutdown: () => {
    cache.close();
    return pool.end();
  },
});
