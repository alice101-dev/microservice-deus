export const AMOUNT_PATTERN = "^(0|[1-9][0-9]{0,17})(\\.[0-9]{1,2})?$";
const AMOUNT = new RegExp(AMOUNT_PATTERN);

export class AmountError extends Error {
  constructor(value: string) {
    super(`invalid amount ${JSON.stringify(value)}: use a non-negative decimal with at most 2 fraction digits`);
    this.name = "AmountError";
  }
}

export function toCents(value: string): bigint {
  if (!AMOUNT.test(value)) throw new AmountError(value);
  const [units = "0", fraction = ""] = value.split(".");
  return BigInt(units) * 100n + BigInt(fraction.padEnd(2, "0"));
}

export function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const units = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${units}.${fraction}`;
}

export function sum(values: readonly string[]): bigint {
  return values.reduce((total, value) => total + toCents(value), 0n);
}

export function normalize(value: string): string {
  return fromCents(toCents(value));
}

export const QUANTITY_PATTERN = "^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,4})?$";
export const RATE_PATTERN = "^(100(\\.0{1,2})?|[0-9]{1,2}(\\.[0-9]{1,2})?)$";
const QUANTITY = new RegExp(QUANTITY_PATTERN);
const RATE = new RegExp(RATE_PATTERN);

function scaled(value: string, pattern: RegExp, digits: number): bigint {
  if (!pattern.test(value)) throw new AmountError(value);
  const [units = "0", fraction = ""] = value.split(".");
  return BigInt(units) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0"));
}

function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export function lineAmount(quantity: string, unitPrice: string): bigint {
  return divideHalfUp(scaled(quantity, QUANTITY, 4) * toCents(unitPrice), 10_000n);
}

export function percentOf(cents: bigint, rate: string): bigint {
  return divideHalfUp(cents * scaled(rate, RATE, 2), 10_000n);
}
