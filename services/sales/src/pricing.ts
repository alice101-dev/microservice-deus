import type { AccountRef, ProductRef } from "@deus/clients";
import { UnprocessableError } from "@deus/errors";
import { fromCents, lineAmount, normalize, percentOf } from "@deus/money";

export interface LineInput {
  productId?: string;
  description?: string;
  quantity: string;
  unitPrice?: string;
  vatRate?: string;
  revenueAccountId?: string;
}

export interface PricedLine {
  lineNo: number;
  productId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
  amount: string;
  vatAmount: string;
  revenueAccountId: string;
}

export function priceLines(
  lines: readonly LineInput[],
  products: ReadonlyMap<string, ProductRef>,
  accounts: ReadonlyMap<string, AccountRef>,
) {
  let subtotal = 0n;
  let vatTotal = 0n;
  const priced = lines.map((line, index): PricedLine => {
    const lineNo = index + 1;
    const product = line.productId ? products.get(line.productId) : undefined;
    if (line.productId && (!product || !product.active)) {
      throw new UnprocessableError(`Line ${lineNo}: the product does not exist or is inactive`, { line: lineNo });
    }
    const description = line.description ?? product?.name;
    const unitPrice = line.unitPrice ?? product?.salePrice ?? undefined;
    const revenueAccountId = line.revenueAccountId ?? product?.revenueAccountId ?? undefined;
    const vatRate = line.vatRate ?? product?.vatRate ?? "11";
    if (!description) throw new UnprocessableError(`Line ${lineNo}: a description is required`, { line: lineNo });
    if (unitPrice === undefined)
      throw new UnprocessableError(`Line ${lineNo}: a unit price is required`, { line: lineNo });
    if (!revenueAccountId) {
      throw new UnprocessableError(`Line ${lineNo}: a revenue account is required`, { line: lineNo });
    }
    const account = accounts.get(revenueAccountId);
    if (!account || !account.active || !account.postable || account.type !== "revenue") {
      throw new UnprocessableError(
        `Line ${lineNo}: the revenue account must be an active revenue account without sub-accounts`,
        {
          line: lineNo,
        },
      );
    }
    if (!/[1-9]/.test(line.quantity)) {
      throw new UnprocessableError(`Line ${lineNo}: the quantity must be greater than zero`, { line: lineNo });
    }
    const amount = lineAmount(line.quantity, unitPrice);
    const vat = percentOf(amount, vatRate);
    subtotal += amount;
    vatTotal += vat;
    return {
      lineNo,
      productId: line.productId ?? null,
      description,
      quantity: line.quantity,
      unitPrice: normalize(unitPrice),
      vatRate: Number(vatRate).toFixed(2),
      amount: fromCents(amount),
      vatAmount: fromCents(vat),
      revenueAccountId,
    };
  });
  return {
    lines: priced,
    subtotal: fromCents(subtotal),
    vatTotal: fromCents(vatTotal),
    total: fromCents(subtotal + vatTotal),
  };
}
