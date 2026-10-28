import { describe, expect, test } from "bun:test";
import { AmountError, fromCents, normalize, sum, toCents } from "../src";

describe("money", () => {
  test("converts decimal strings to cents without floating point", () => {
    expect(toCents("0.1")).toBe(10n);
    expect(toCents("1500000.25")).toBe(150000025n);
    expect(toCents("999999999999999999.99")).toBe(99999999999999999999n);
    expect(sum(["0.10", "0.20"])).toBe(30n);
  });

  test("formats cents with two fraction digits", () => {
    expect(fromCents(150000025n)).toBe("1500000.25");
    expect(fromCents(-5n)).toBe("-0.05");
    expect(normalize("7")).toBe("7.00");
  });

  test("rejects negative, malformed and over-precise amounts", () => {
    for (const value of ["-1", "1.234", "01", "1e3", "", " 1", "1.", "abc"]) {
      expect(() => toCents(value)).toThrow(AmountError);
    }
  });
});
