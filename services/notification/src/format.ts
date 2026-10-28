export function rupiah(amount: string) {
  const negative = amount.startsWith("-");
  const [units = "0", fraction = "00"] = (negative ? amount.slice(1) : amount).split(".");
  const grouped = units.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}Rp ${grouped},${fraction.padEnd(2, "0").slice(0, 2)}`;
}

const MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

export function tanggal(isoDate: string) {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export function winAnsi(text: string) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "?");
}
