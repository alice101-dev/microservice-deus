import { join } from "node:path";
import { DatabaseConfig, loadConfig } from "@deus/config";
import { runMigrationJob } from "@deus/db/migrate";
import { createLogger } from "@deus/logger";
import { startTelemetry } from "@deus/telemetry";

const config = loadConfig(DatabaseConfig);
const telemetry = startTelemetry({
  serviceName: `${config.SERVICE_NAME}-migrations`,
  serviceVersion: config.SERVICE_VERSION,
  serviceNamespace: config.SERVICE_NAMESPACE,
  environment: config.DEPLOYMENT_ENVIRONMENT,
  endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
});
const logger = createLogger({ name: `${config.SERVICE_NAME}-migrations`, stdout: true });

await runMigrationJob({
  directory: process.env.MIGRATIONS_DIR ?? join(import.meta.dir, "../migrations"),
  connection: {
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
  },
  logger,
  flush: () => telemetry.shutdown(),
});
