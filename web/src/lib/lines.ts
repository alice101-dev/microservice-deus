import { fromCents, lineAmount, percentOf, QUANTITY_PATTERN } from "@deus/money";
import { toAmount } from "./format.ts";

export interface EditableLine {
  key: string;
  productId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
  accountId: string;
}

export interface ProductOption {
  id: string;
  sku: string;
  name: string;
  salePrice: string | null;
  purchasePrice: string | null;
  vatRate: string;
  revenueAccountId: string | null;
  expenseAccountId: string | null;
}

const QUANTITY = new RegExp(QUANTITY_PATTERN);

export function blankLine(): EditableLine {
  return {
    key: crypto.randomUUID(),
    productId: "",
    description: "",
    quantity: "1",
    unitPrice: "",
    vatRate: "11",
    accountId: "",
  };
}

export function applyProduct(line: EditableLine, product: ProductOption | undefined, side: "sale" | "purchase") {
  if (!product) return { ...line, productId: "" };
  const price = side === "sale" ? product.salePrice : product.purchasePrice;
  const account = side === "sale" ? product.revenueAccountId : product.expenseAccountId;
  return {
    ...line,
    productId: product.id,
    description: product.name,
    unitPrice: price ?? line.unitPrice,
    vatRate: String(Number(product.vatRate)),
    accountId: account ?? line.accountId,
  };
}

export function lineTotals(line: EditableLine) {
  const price = toAmount(line.unitPrice);
  const quantity = line.quantity.trim().replace(",", ".");
  const rate = line.vatRate.trim().replace(",", ".");
  if (!price || !QUANTITY.test(quantity) || !/^\d{1,3}(\.\d{1,2})?$/.test(rate) || Number(rate) > 100) return null;
  const amount = lineAmount(quantity, price);
  return { amount, vat: percentOf(amount, rate), quantity, price, rate };
}

export function documentTotals(lines: readonly EditableLine[]) {
  let subtotal = 0n;
  let vat = 0n;
  for (const line of lines) {
    const totals = lineTotals(line);
    if (!totals) continue;
    subtotal += totals.amount;
    vat += totals.vat;
  }
  return { subtotal: fromCents(subtotal), vat: fromCents(vat), total: fromCents(subtotal + vat) };
}

export function toRequestLines(lines: readonly EditableLine[]) {
  const problems: string[] = [];
  const payload = lines.map((line, index) => {
    const totals = lineTotals(line);
    if (!totals) problems.push(`Baris ${index + 1}: periksa jumlah, harga, dan PPN`);
    if (!line.description.trim()) problems.push(`Baris ${index + 1}: keterangan wajib diisi`);
    if (!line.accountId) problems.push(`Baris ${index + 1}: pilih akun`);
    return {
      ...(line.productId ? { productId: line.productId } : {}),
      description: line.description.trim(),
      quantity: totals?.quantity ?? line.quantity,
      unitPrice: totals?.price ?? line.unitPrice,
      vatRate: totals?.rate ?? line.vatRate,
      accountId: line.accountId,
    };
  });
  return { payload, problems };
}
