import { describe, expect, test } from "bun:test";
import { AmountError, fromCents, lineAmount, normalize, percentOf, sum, toCents } from "../src";

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

describe("line amounts and percentages", () => {
  test("multiplies a fractional quantity by a price and rounds half up to the cent", () => {
    expect(fromCents(lineAmount("3", "85000"))).toBe("255000.00");
    expect(fromCents(lineAmount("1.5", "0.99"))).toBe("1.49");
    expect(fromCents(lineAmount("0.3333", "10"))).toBe("3.33");
    expect(fromCents(lineAmount("2.5", "0.01"))).toBe("0.03");
    expect(() => lineAmount("1.23456", "1")).toThrow(AmountError);
    expect(() => lineAmount("-1", "1")).toThrow(AmountError);
  });

  test("takes a percentage of an amount in cents", () => {
    expect(fromCents(percentOf(toCents("255000"), "11"))).toBe("28050.00");
    expect(fromCents(percentOf(toCents("1.49"), "11"))).toBe("0.16");
    expect(fromCents(percentOf(toCents("100"), "0"))).toBe("0.00");
    expect(fromCents(percentOf(toCents("100"), "100"))).toBe("100.00");
    expect(() => percentOf(100n, "101")).toThrow(AmountError);
  });
});
