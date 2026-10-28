export interface StatementRow {
  date: string;
  description: string;
  amount: string;
  reference?: string;
}

export function parseCsv(
  text: string,
  delimiter = text.includes(";") && !text.split("\n")[0]?.includes(",") ? ";" : ",",
) {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

export function parseDate(value: string) {
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${(month ?? "").padStart(2, "0")}-${(day ?? "").padStart(2, "0")}`;
}

export function parseAmount(value: string) {
  let text = value.trim().replace(/\s|Rp/gi, "");
  if (text === "") return null;
  const negative = text.startsWith("-") || (text.startsWith("(") && text.endsWith(")"));
  text = text.replace(/[-()]/g, "");
  if (/,\d{1,2}$/.test(text)) text = text.replace(/\./g, "").replace(",", ".");
  else if (/\.\d{3}(\.|$)/.test(text) && !/\.\d{1,2}$/.test(text)) text = text.replace(/\./g, "");
  else text = text.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  return negative ? `-${text}` : text;
}

const HEADERS = {
  date: ["date", "tanggal", "tgl"],
  description: ["description", "keterangan", "uraian", "deskripsi"],
  amount: ["amount", "jumlah", "nominal", "mutasi"],
  debit: ["debit", "debet", "keluar"],
  credit: ["credit", "kredit", "masuk"],
  reference: ["reference", "referensi", "ref", "no. referensi"],
};

export function statementRows(text: string): { rows: StatementRow[]; errors: string[] } {
  const [header, ...body] = parseCsv(text);
  if (!header) return { rows: [], errors: ["File kosong"] };
  const names = header.map((name) => name.trim().toLowerCase());
  const column = (keys: string[]) => names.findIndex((name) => keys.includes(name));
  const index = {
    date: column(HEADERS.date),
    description: column(HEADERS.description),
    amount: column(HEADERS.amount),
    debit: column(HEADERS.debit),
    credit: column(HEADERS.credit),
    reference: column(HEADERS.reference),
  };
  if (index.date < 0 || index.description < 0 || (index.amount < 0 && (index.debit < 0 || index.credit < 0))) {
    return { rows: [], errors: ["Kolom wajib: tanggal, keterangan, dan jumlah (atau debit dan kredit)"] };
  }
  const rows: StatementRow[] = [];
  const errors: string[] = [];
  body.forEach((cells, position) => {
    const line = position + 2;
    const date = parseDate(cells[index.date] ?? "");
    let amount: string | null;
    if (index.amount >= 0) amount = parseAmount(cells[index.amount] ?? "");
    else {
      const out = parseAmount(cells[index.debit] ?? "");
      const incoming = parseAmount(cells[index.credit] ?? "");
      amount = incoming && incoming !== "0" ? incoming : out && out !== "0" ? `-${out.replace(/^-/, "")}` : null;
    }
    const description = (cells[index.description] ?? "").trim();
    if (!date || !amount || !description || /^-?0+(\.0+)?$/.test(amount)) {
      errors.push(`Baris ${line} dilewati`);
      return;
    }
    const reference = index.reference >= 0 ? (cells[index.reference] ?? "").trim() : "";
    rows.push({ date, description, amount, ...(reference ? { reference } : {}) });
  });
  return { rows, errors };
}
