import { describe, expect, test } from "bun:test";
import { ConflictError, NotFoundError, toProblem } from "../src";

describe("toProblem", () => {
  test("exposes client errors with their details", () => {
    const body = toProblem(new ConflictError("Journal is already posted", { journalId: "j-1" }), { instance: "/x" });
    expect(body).toEqual({
      type: "urn:deus:error:conflict",
      title: "Conflict",
      status: 409,
      code: "conflict",
      detail: "Journal is already posted",
      errors: { journalId: "j-1" },
      instance: "/x",
    });
  });

  test("hides the message of unexpected errors", () => {
    const body = toProblem(new Error("connection string postgres://user:secret@db"), { traceId: "abc" });
    expect(body).toEqual({
      type: "urn:deus:error:internal",
      title: "Internal Server Error",
      status: 500,
      code: "internal",
      traceId: "abc",
    });
  });

  test("names the error class", () => {
    expect(new NotFoundError().name).toBe("NotFoundError");
  });
});
