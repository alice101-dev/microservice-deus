import { loadConfig } from "@deus/config";
import { serve } from "@deus/http";
import { createLogger } from "@deus/logger";
import { startTelemetry } from "@deus/telemetry";
import { Type } from "@sinclair/typebox";
import { createWebServer } from "./static.ts";

const config = loadConfig({ STATIC_ROOT: Type.String({ default: "./build" }) });
const telemetry = startTelemetry({
  serviceName: config.SERVICE_NAME,
  serviceVersion: config.SERVICE_VERSION,
  serviceNamespace: config.SERVICE_NAMESPACE,
  environment: config.DEPLOYMENT_ENVIRONMENT,
  endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  metricExportIntervalMs: config.OTEL_METRIC_EXPORT_INTERVAL,
});
const logger = createLogger({ name: config.SERVICE_NAME, level: config.LOG_LEVEL, stdout: config.LOG_STDOUT });

serve(createWebServer({ config, logger, root: config.STATIC_ROOT }), { config, logger, telemetry });
