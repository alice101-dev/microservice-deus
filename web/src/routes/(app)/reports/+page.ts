import { api, call } from "#lib/api.ts";
import { currentPeriod, monthRange, today } from "#lib/format.ts";

export async function load({ url }) {
  const month = monthRange(currentPeriod());
  const from = url.searchParams.get("from") ?? month.from;
  const to = url.searchParams.get("to") ?? today();
  const [income, sheet, snapshots] = await Promise.all([
    call(api.reporting["income-statement"].get({ query: { from, to } })),
    call(api.reporting["balance-sheet"].get({ query: { asOf: to } })),
    call(api.reporting.statements.get({ query: {} })),
  ]);
  return { from, to, income, sheet, snapshots };
}
