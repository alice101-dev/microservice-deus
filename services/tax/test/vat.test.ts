import { describe, expect, test } from "bun:test";
import { calculate, periodEnd, settlementJournal } from "../src/vat";

const accounts = { output: "out", input: "in", payable: "pay" };
const vatReturn = (outputVat: string, inputVat: string, payable: string) => ({
  id: "r1",
  organizationId: "org",
  period: "2026-03",
  outputVat,
  inputVat,
  payable,
});

describe("VAT return", () => {
  test("nets output against input VAT and carries an excess forward", () => {
    expect(
      calculate(
        [
          { accountId: "out", debit: "0.00", credit: "1100000.00" },
          { accountId: "in", debit: "330000.00", credit: "0.00" },
        ],
        accounts,
      ),
    ).toEqual({ outputVat: "1100000.00", inputVat: "330000.00", payable: "770000.00", carriedForward: "0.00" });
    expect(
      calculate(
        [
          { accountId: "in", debit: "500000.00", credit: "0.00" },
          { accountId: "out", debit: "0", credit: "200000" },
        ],
        accounts,
      ),
    ).toEqual({
      outputVat: "200000.00",
      inputVat: "500000.00",
      payable: "0.00",
      carriedForward: "300000.00",
    });
    expect(calculate([], accounts).payable).toBe("0.00");
  });

  test("posts Dr output, Cr input and Cr payable, leaving excess input on its account", () => {
    expect(
      settlementJournal(vatReturn("1100000.00", "330000.00", "770000.00"), accounts, {
        createdBy: "u",
        date: "2026-04-10",
      })?.lines,
    ).toEqual([
      { accountId: "out", debit: "1100000.00", memo: "PPN Keluaran 2026-03" },
      { accountId: "in", credit: "330000.00", memo: "PPN Masukan 2026-03" },
      { accountId: "pay", credit: "770000.00", memo: "PPN kurang bayar 2026-03" },
    ]);
    expect(
      settlementJournal(vatReturn("200000.00", "500000.00", "0.00"), accounts, { createdBy: "u", date: "2026-04-10" })
        ?.lines,
    ).toEqual([
      { accountId: "out", debit: "200000.00", memo: "PPN Keluaran 2026-03" },
      { accountId: "in", credit: "200000.00", memo: "PPN Masukan 2026-03" },
    ]);
    expect(
      settlementJournal(vatReturn("0.00", "500000.00", "0.00"), accounts, { createdBy: "u", date: "2026-04-10" }),
    ).toBeNull();
  });

  test("finds the last day of a period", () => {
    expect(periodEnd("2026-02")).toBe("2026-02-28");
    expect(periodEnd("2028-02")).toBe("2028-02-29");
    expect(periodEnd("2026-12")).toBe("2026-12-31");
  });
});
