import { describe, expect, test } from "vitest";
import { rupiah, sumAmounts, toAmount } from "./format.ts";
import { applyProduct, blankLine, documentTotals, toRequestLines } from "./lines.ts";

const kopi = {
  id: "p1",
  sku: "KOPI-250",
  name: "Kopi Arabika 250g",
  salePrice: "85000.00",
  purchasePrice: "60000.00",
  vatRate: "11.00",
  revenueAccountId: "rev",
  expenseAccountId: "inv",
};

describe("document lines", () => {
  test("prefills a line from the product for sales and purchases", () => {
    expect(applyProduct(blankLine(), kopi, "sale")).toMatchObject({
      description: "Kopi Arabika 250g",
      unitPrice: "85000.00",
      vatRate: "11",
      accountId: "rev",
    });
    expect(applyProduct(blankLine(), kopi, "purchase")).toMatchObject({ unitPrice: "60000.00", accountId: "inv" });
  });

  test("totals lines exactly like the backend, ignoring incomplete ones", () => {
    const lines = [
      { ...applyProduct(blankLine(), kopi, "sale"), quantity: "3" },
      { ...blankLine(), description: "Ongkir", quantity: "1,5", unitPrice: "0,99", vatRate: "11", accountId: "rev" },
      { ...blankLine(), description: "Belum lengkap", unitPrice: "" },
    ];
    expect(documentTotals(lines)).toEqual({ subtotal: "255001.49", vat: "28050.16", total: "283051.65" });
    const { payload, problems } = toRequestLines(lines);
    expect(payload[1]).toMatchObject({ quantity: "1.5", unitPrice: "0.99", vatRate: "11" });
    expect(problems).toEqual(["Baris 3: periksa jumlah, harga, dan PPN", "Baris 3: pilih akun"]);
  });

  test("formats and parses rupiah amounts", () => {
    expect(rupiah("1500000.00")).toBe("Rp 1.500.000,00");
    expect(rupiah("-6500.5")).toBe("-Rp 6.500,50");
    expect(rupiah(null)).toBe("—");
    expect(toAmount("Rp 1.500.000,50")).toBe("1500000.50");
    expect(toAmount("85000")).toBe("85000");
    expect(toAmount("85000.00")).toBe("85000.00");
    expect(toAmount("85.000")).toBe("85000");
    expect(toAmount("0,99")).toBe("0.99");
    expect(toAmount("12,345")).toBeNull();
    expect(toAmount("1.2.3")).toBeNull();
    expect(sumAmounts(["100.00", "-30.50", "0.50"])).toBe("70.00");
  });
});
