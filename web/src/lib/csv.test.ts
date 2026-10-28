import { describe, expect, test } from "vitest";
import { parseAmount, parseDate, statementRows } from "./csv.ts";

describe("bank statement CSV", () => {
  test("reads Indonesian and international amounts", () => {
    expect(parseAmount("1.500.000,00")).toBe("1500000.00");
    expect(parseAmount("-15.000")).toBe("-15000");
    expect(parseAmount("(6.500,50)")).toBe("-6500.50");
    expect(parseAmount("1,234.56")).toBe("1234.56");
    expect(parseAmount("Rp 85000")).toBe("85000");
    expect(parseAmount("abc")).toBeNull();
  });

  test("reads ISO and day-first dates", () => {
    expect(parseDate("2026-10-28")).toBe("2026-10-28");
    expect(parseDate("28/10/2026")).toBe("2026-10-28");
    expect(parseDate("1-3-2026")).toBe("2026-03-01");
    expect(parseDate("10/28")).toBeNull();
  });

  test("maps headers, debit and credit columns, quotes, and skips bad rows", () => {
    const csv = [
      "Tanggal;Keterangan;Debet;Kredit;Referensi",
      '28/10/2026;"TRF MASUK; PT SETIA";;100.000,00;TRF-1',
      "28/10/2026;BIAYA ADM;6.500,00;;",
      "bukan tanggal;X;1;;",
    ].join("\n");
    const { rows, errors } = statementRows(csv);
    expect(rows).toEqual([
      { date: "2026-10-28", description: "TRF MASUK; PT SETIA", amount: "100000.00", reference: "TRF-1" },
      { date: "2026-10-28", description: "BIAYA ADM", amount: "-6500.00" },
    ]);
    expect(errors).toEqual(["Baris 4 dilewati"]);
    expect(statementRows("a,b\n1,2").errors[0]).toContain("Kolom wajib");
  });
});
