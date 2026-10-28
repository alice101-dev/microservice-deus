import { expect, test } from "bun:test";
import { databaseUnavailable } from "../src";
import { connectWhenReady } from "../src/migrate";

const failure = (code: string) => Object.assign(new Error(code), { code });
const quiet = { info: () => {} };
const noSleep = async () => {};

test("waits while the database is not ready yet, then connects", async () => {
  const errors = [failure("ECONNREFUSED"), failure("3D000"), failure("28P01")];
  const waits: string[] = [];
  const logger = { info: (_: string, attributes?: Record<string, unknown>) => waits.push(String(attributes?.reason)) };
  const client = await connectWhenReady(
    async () => {
      const error = errors.shift();
      if (error) throw error;
      return "connected";
    },
    logger,
    { sleep: noSleep },
  );
  expect(client).toBe("connected");
  expect(waits).toEqual(["ECONNREFUSED", "3D000", "28P01"]);
});

test("fails at once on an error that waiting does not fix", async () => {
  let attempts = 0;
  const connect = async () => {
    attempts++;
    throw failure("42501");
  };
  expect(connectWhenReady(connect, quiet, { sleep: noSleep })).rejects.toThrow("42501");
  expect(attempts).toBe(1);
});

test("gives up after the timeout", async () => {
  const connect = async () => {
    throw failure("ECONNREFUSED");
  };
  expect(connectWhenReady(connect, quiet, { timeoutMs: 0, sleep: noSleep })).rejects.toThrow("ECONNREFUSED");
});

test("tells an unreachable database from a broken query", () => {
  expect(databaseUnavailable(failure("57P03"))).toBe(true);
  expect(databaseUnavailable(failure("42P01"))).toBe(false);
  expect(databaseUnavailable(new Error("no code"))).toBe(false);
  const wrapped = new Error("Failed query: update outbox", {
    cause: new Error("Connection terminated due to connection timeout"),
  });
  expect(databaseUnavailable(wrapped)).toBe(true);
});
