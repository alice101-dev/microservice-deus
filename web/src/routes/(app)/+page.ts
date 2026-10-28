import { api, call } from "#lib/api.ts";
import { currentPeriod, monthRange, today } from "#lib/format.ts";

export async function load() {
  const asOf = today();
  const month = monthRange(currentPeriod());
  const [sheet, income, invoices, bills] = await Promise.all([
    call(api.reporting["balance-sheet"].get({ query: { asOf } })),
    call(api.reporting["income-statement"].get({ query: { from: month.from, to: asOf } })),
    call(api.sales.invoices.get({ query: { status: "issued" } })),
    call(api.purchases.bills.get({ query: { status: "approved" } })),
  ]);
  return { asOf, sheet, income, invoices, bills };
}
