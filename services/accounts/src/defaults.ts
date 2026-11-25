import type { ACCOUNT_TYPES } from "./schema";

type Type = (typeof ACCOUNT_TYPES)[number];

export const DEFAULT_CHART: ReadonlyArray<{ code: string; name: string; type: Type; parent?: string }> = [
  { code: "1-0000", name: "Aset", type: "asset" },
  { code: "1-1000", name: "Kas", type: "asset", parent: "1-0000" },
  { code: "1-1100", name: "Bank", type: "asset", parent: "1-0000" },
  { code: "1-1200", name: "Piutang Usaha", type: "asset", parent: "1-0000" },
  { code: "1-1300", name: "Persediaan", type: "asset", parent: "1-0000" },
  { code: "1-1400", name: "PPN Masukan", type: "asset", parent: "1-0000" },
  { code: "1-2000", name: "Aset Tetap", type: "asset", parent: "1-0000" },
  { code: "1-2100", name: "Akumulasi Penyusutan", type: "asset", parent: "1-0000" },
  { code: "2-0000", name: "Liabilitas", type: "liability" },
  { code: "2-1000", name: "Utang Usaha", type: "liability", parent: "2-0000" },
  { code: "2-1100", name: "PPN Keluaran", type: "liability", parent: "2-0000" },
  { code: "2-1200", name: "Utang Pajak", type: "liability", parent: "2-0000" },
  { code: "2-2000", name: "Utang Bank", type: "liability", parent: "2-0000" },
  { code: "3-0000", name: "Ekuitas", type: "equity" },
  { code: "3-1000", name: "Modal Disetor", type: "equity", parent: "3-0000" },
  { code: "3-2000", name: "Laba Ditahan", type: "equity", parent: "3-0000" },
  { code: "4-0000", name: "Pendapatan", type: "revenue" },
  { code: "4-1000", name: "Pendapatan Penjualan", type: "revenue", parent: "4-0000" },
  { code: "4-2000", name: "Pendapatan Lain-lain", type: "revenue", parent: "4-0000" },
  { code: "5-0000", name: "Harga Pokok Penjualan", type: "expense" },
  { code: "5-1000", name: "Pembelian Barang Dagang", type: "expense", parent: "5-0000" },
  { code: "6-0000", name: "Beban Operasional", type: "expense" },
  { code: "6-1000", name: "Beban Gaji", type: "expense", parent: "6-0000" },
  { code: "6-2000", name: "Beban Sewa", type: "expense", parent: "6-0000" },
  { code: "6-3000", name: "Beban Listrik dan Air", type: "expense", parent: "6-0000" },
  { code: "6-4000", name: "Beban Penyusutan", type: "expense", parent: "6-0000" },
  { code: "6-9000", name: "Beban Lain-lain", type: "expense", parent: "6-0000" },
];
