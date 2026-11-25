import { describe, expect, test } from "bun:test";
import type { AccountRef, ProductRef } from "@deus/clients";
import { UnprocessableError } from "@deus/errors";
import {
  addDays,
  documentNumber,
  PURCHASE_PRICING,
  priceLines,
  SALE_PRICING,
  totalsByAccount,
  trimQuantity,
} from "../src";

const account = (id: string, type: AccountRef["type"], postable = true): AccountRef => ({
  id,
  code: id,
  name: id,
  type,
  parentId: null,
  active: true,
  postable,
});
const accounts = new Map(
  [account("rev", "revenue"), account("exp", "expense"), account("inv", "asset"), account("hdr", "revenue", false)].map(
    (entry) => [entry.id, entry],
  ),
);
const kopi: ProductRef = {
  id: "kopi",
  sku: "KOPI-250",
  name: "Kopi Arabika 250g",
  kind: "goods",
  unit: "pcs",
  salePrice: "85000",
  purchasePrice: "60000",
  vatRate: "11.00",
  revenueAccountId: "rev",
  expenseAccountId: "inv",
  active: true,
};
const products = new Map([[kopi.id, kopi]]);

describe("documents", () => {
  test("prices sales and purchases from the matching product defaults", () => {
    const sale = priceLines([{ productId: "kopi", quantity: "3" }], products, accounts, SALE_PRICING);
    expect(sale).toMatchObject({ subtotal: "255000.00", vatTotal: "28050.00", total: "283050.00" });
    expect(sale.lines[0]).toMatchObject({ unitPrice: "85000.00", accountId: "rev", vatRate: "11.00" });
    const purchase = priceLines([{ productId: "kopi", quantity: "10" }], products, accounts, PURCHASE_PRICING);
    expect(purchase).toMatchObject({ subtotal: "600000.00", vatTotal: "66000.00", total: "666000.00" });
    expect(purchase.lines[0]?.accountId).toBe("inv");
  });

  test("refuses accounts of the wrong kind, header accounts and zero quantities", () => {
    const attempt =
      (line: Record<string, string>, rules = SALE_PRICING) =>
      () =>
        priceLines([{ description: "x", unitPrice: "1", quantity: "1", ...line }], products, accounts, rules);
    expect(attempt({ accountId: "exp" })).toThrow(UnprocessableError);
    expect(attempt({ accountId: "hdr" })).toThrow(UnprocessableError);
    expect(attempt({ accountId: "rev" }, PURCHASE_PRICING)).toThrow(UnprocessableError);
    expect(attempt({ accountId: "rev", quantity: "0.000" })).toThrow("greater than zero");
    expect(attempt({ accountId: "exp" }, PURCHASE_PRICING)).not.toThrow();
  });

  test("groups amounts by account and formats numbers, dates and quantities", () => {
    expect(
      totalsByAccount([
        { accountId: "a", amount: "10.50" },
        { accountId: "b", amount: "0.00" },
        { accountId: "a", amount: "4.50" },
      ]),
    ).toEqual([{ accountId: "a", amount: "15.00" }]);
    expect(addDays("2026-12-25", 14)).toBe("2027-01-08");
    expect(documentNumber("BILL", 2026, 7)).toBe("BILL/2026/0007");
    expect(trimQuantity("1.5000")).toBe("1.5");
    expect(trimQuantity("3.0000")).toBe("3");
  });
});
