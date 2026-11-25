import type { AccountRef, ProductRef } from "@deus/clients";
import { UnprocessableError } from "@deus/errors";
import { fromCents, lineAmount, normalize, percentOf, toCents } from "@deus/money";

export interface LineInput {
  productId?: string;
  description?: string;
  quantity: string;
  unitPrice?: string;
  vatRate?: string;
  accountId?: string;
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
  accountId: string;
}

export interface PricingRules {
  price: (product: ProductRef) => string | null;
  account: (product: ProductRef) => string | null;
  accountTypes: ReadonlySet<AccountRef["type"]>;
  accountLabel: string;
}

export const SALE_PRICING: PricingRules = {
  price: (product) => product.salePrice,
  account: (product) => product.revenueAccountId,
  accountTypes: new Set(["revenue"]),
  accountLabel: "revenue account",
};

export const PURCHASE_PRICING: PricingRules = {
  price: (product) => product.purchasePrice,
  account: (product) => product.expenseAccountId,
  accountTypes: new Set(["expense", "asset"]),
  accountLabel: "expense or asset account",
};

export function lineAccountIds(
  lines: readonly LineInput[],
  products: ReadonlyMap<string, ProductRef>,
  rules: PricingRules,
) {
  return lines.flatMap((line) => {
    const product = line.productId ? products.get(line.productId) : undefined;
    const id = line.accountId ?? (product ? rules.account(product) : null);
    return id ? [id] : [];
  });
}

export function priceLines(
  lines: readonly LineInput[],
  products: ReadonlyMap<string, ProductRef>,
  accounts: ReadonlyMap<string, AccountRef>,
  rules: PricingRules,
) {
  let subtotal = 0n;
  let vatTotal = 0n;
  const priced = lines.map((line, index): PricedLine => {
    const lineNo = index + 1;
    const fail = (message: string) => new UnprocessableError(`Line ${lineNo}: ${message}`, { line: lineNo });
    const product = line.productId ? products.get(line.productId) : undefined;
    if (line.productId && !product?.active) throw fail("the product does not exist or is inactive");
    const description = line.description ?? product?.name;
    const unitPrice = line.unitPrice ?? (product ? rules.price(product) : null) ?? undefined;
    const accountId = line.accountId ?? (product ? rules.account(product) : null) ?? undefined;
    const vatRate = line.vatRate ?? product?.vatRate ?? "11";
    if (!description) throw fail("a description is required");
    if (unitPrice === undefined) throw fail("a unit price is required");
    if (!accountId) throw fail(`a ${rules.accountLabel} is required`);
    const account = accounts.get(accountId);
    if (!account?.active || !account.postable || !rules.accountTypes.has(account.type)) {
      throw fail(`the ${rules.accountLabel} must be active and without sub-accounts`);
    }
    if (!/[1-9]/.test(line.quantity)) throw fail("the quantity must be greater than zero");
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
      accountId,
    };
  });
  return {
    lines: priced,
    subtotal: fromCents(subtotal),
    vatTotal: fromCents(vatTotal),
    total: fromCents(subtotal + vatTotal),
  };
}

export function totalsByAccount(lines: ReadonlyArray<{ accountId: string; amount: string }>) {
  const totals = new Map<string, bigint>();
  for (const line of lines) totals.set(line.accountId, (totals.get(line.accountId) ?? 0n) + toCents(line.amount));
  return [...totals.entries()]
    .filter(([, cents]) => cents > 0n)
    .map(([accountId, cents]) => ({ accountId, amount: fromCents(cents) }));
}

export function amountDue(total: string, paid: string) {
  return fromCents(toCents(total) - toCents(paid));
}

export function addDays(isoDate: string, days: number) {
  const value = new Date(`${isoDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export const today = (timeZone = "Asia/Jakarta") => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());

export const trimQuantity = (value: string) => (value.includes(".") ? value.replace(/\.?0+$/, "") : value);

export const documentNumber = (prefix: string, year: number, sequence: number) =>
  `${prefix}/${year}/${String(sequence).padStart(4, "0")}`;
