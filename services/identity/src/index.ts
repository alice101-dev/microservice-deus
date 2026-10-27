import { loadConfig } from "@deus/config";
import { serve } from "@deus/http";
import { createLogger } from "@deus/logger";
import { startTelemetry } from "@deus/telemetry";
import { createApp } from "./app";

const config = loadConfig({});
const telemetry = startTelemetry({
  serviceName: config.SERVICE_NAME,
  serviceVersion: config.SERVICE_VERSION,
  serviceNamespace: config.SERVICE_NAMESPACE,
  environment: config.DEPLOYMENT_ENVIRONMENT,
  endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  metricExportIntervalMs: config.OTEL_METRIC_EXPORT_INTERVAL,
});
const logger = createLogger({ name: config.SERVICE_NAME, level: config.LOG_LEVEL, stdout: config.LOG_STDOUT });

serve(createApp(config, logger), { config, logger, telemetry });
