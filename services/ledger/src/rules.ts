import { UnprocessableError } from "@deus/errors";
import { fromCents, toCents } from "@deus/money";

export interface LineInput {
  accountId: string;
  debit?: string;
  credit?: string;
  memo?: string;
}

export interface NormalizedLine {
  lineNo: number;
  accountId: string;
  debit: string;
  credit: string;
  memo: string | null;
}

export function normalizeLines(lines: readonly LineInput[]) {
  if (lines.length < 2) throw new UnprocessableError("A journal needs at least two lines");
  let debit = 0n;
  let credit = 0n;
  const normalized: NormalizedLine[] = lines.map((line, index) => {
    const lineDebit = toCents(line.debit ?? "0");
    const lineCredit = toCents(line.credit ?? "0");
    if (lineDebit > 0n === lineCredit > 0n) {
      throw new UnprocessableError(`Line ${index + 1} must have either a debit or a credit`, { line: index + 1 });
    }
    debit += lineDebit;
    credit += lineCredit;
    return {
      lineNo: index + 1,
      accountId: line.accountId,
      debit: fromCents(lineDebit),
      credit: fromCents(lineCredit),
      memo: line.memo ?? null,
    };
  });
  if (debit !== credit) {
    throw new UnprocessableError("Debits and credits must balance", {
      debit: fromCents(debit),
      credit: fromCents(credit),
    });
  }
  return { lines: normalized, total: fromCents(debit) };
}

export const periodOf = (isoDate: string) => isoDate.slice(0, 7);
