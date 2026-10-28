import { fromCents, toCents } from "@deus/money";

export function rupiah(amount: string | null | undefined) {
  if (amount === null || amount === undefined || amount === "") return "—";
  const negative = amount.startsWith("-");
  const [units = "0", fraction = "00"] = (negative ? amount.slice(1) : amount).split(".");
  const grouped = units.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}Rp ${grouped},${fraction.padEnd(2, "0").slice(0, 2)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

export function tanggal(isoDate: string | null | undefined) {
  if (!isoDate) return "—";
  const [year, month, day] = isoDate.slice(0, 10).split("-").map(Number) as [number, number, number];
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

export function currentPeriod() {
  return today().slice(0, 7);
}

export function monthRange(period: string) {
  const [year, month] = period.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, "0")}` };
}

export function toAmount(input: string) {
  const text = input.trim().replace(/\s/g, "").replace(/^Rp/i, "");
  if (/^\d+(\.\d{1,2})?$/.test(text)) return text;
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(text) && !/^\d+(,\d{1,2})?$/.test(text)) return null;
  return text.replace(/\./g, "").replace(",", ".");
}

export function signedCents(amount: string) {
  return amount.startsWith("-") ? -toCents(amount.slice(1)) : toCents(amount);
}

export function sumAmounts(amounts: readonly string[]) {
  return fromCents(amounts.reduce((total, amount) => total + signedCents(amount), 0n));
}
