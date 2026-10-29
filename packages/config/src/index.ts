import { type Static, type TProperties, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const LogLevel = Type.Union([
  Type.Literal("debug"),
  Type.Literal("info"),
  Type.Literal("warn"),
  Type.Literal("error"),
]);
export type LogLevel = Static<typeof LogLevel>;

export const BaseConfig = Type.Object({
  SERVICE_NAME: Type.String({ minLength: 1 }),
  SERVICE_VERSION: Type.String({ default: "dev" }),
  SERVICE_NAMESPACE: Type.String({ default: "deus" }),
  DEPLOYMENT_ENVIRONMENT: Type.String({ default: "local" }),
  PORT: Type.Integer({ default: 3000, minimum: 1, maximum: 65535 }),
  LOG_LEVEL: Type.Union(LogLevel.anyOf, { default: "info" }),
  LOG_STDOUT: Type.Boolean({ default: false }),
  OTEL_EXPORTER_OTLP_ENDPOINT: Type.String({ default: "http://localhost:4318" }),
  OTEL_METRIC_EXPORT_INTERVAL: Type.Integer({ default: 30000, minimum: 1000 }),
  SHUTDOWN_DRAIN_MS: Type.Integer({ default: 5000, minimum: 0 }),
  SHUTDOWN_FLUSH_MS: Type.Integer({ default: 5000, minimum: 0 }),
});
export type BaseConfig = Static<typeof BaseConfig>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig<P extends TProperties>(extra: P, env: Record<string, string | undefined> = process.env) {
  const schema = Type.Composite([BaseConfig, Type.Object(extra)]);
  const value = Value.Convert(schema, Value.Default(schema, Value.Clean(schema, { ...env })));
  const issues = [...Value.Errors(schema, value)].map(
    (error) => `${error.path.slice(1) || "config"}: ${error.message}`,
  );
  if (issues.length > 0) throw new ConfigError(issues);
  return value as Static<typeof schema>;
}

export const DatabaseConfig = {
  DB_HOST: Type.String({ minLength: 1 }),
  DB_PORT: Type.Integer({ default: 5432, minimum: 1, maximum: 65535 }),
  DB_NAME: Type.String({ minLength: 1 }),
  DB_USER: Type.String({ minLength: 1 }),
  DB_PASSWORD: Type.String({ minLength: 1 }),
  DB_MAX_CONNECTIONS: Type.Integer({ default: 5, minimum: 1 }),
};

export const CacheConfig = {
  REDIS_URL: Type.Optional(Type.String({ minLength: 1 })),
};
