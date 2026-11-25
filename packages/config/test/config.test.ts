import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { ConfigError, loadConfig } from "../src";

describe("loadConfig", () => {
  test("applies defaults, converts strings and drops unknown variables", () => {
    const config = loadConfig(
      { DATABASE_URL: Type.String() },
      { SERVICE_NAME: "ledger", PORT: "8080", LOG_STDOUT: "true", DATABASE_URL: "postgres://db/app", HOME: "/root" },
    );
    expect(config.PORT).toBe(8080);
    expect(config.LOG_STDOUT).toBe(true);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.DATABASE_URL).toBe("postgres://db/app");
    expect(config).not.toHaveProperty("HOME");
  });

  test("reports every invalid variable", () => {
    try {
      loadConfig({ DATABASE_URL: Type.String() }, { PORT: "not-a-port", LOG_LEVEL: "verbose" });
      throw new Error("expected a ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join("\n");
      expect(issues).toContain("SERVICE_NAME");
      expect(issues).toContain("PORT");
      expect(issues).toContain("LOG_LEVEL");
      expect(issues).toContain("DATABASE_URL");
    }
  });
});
