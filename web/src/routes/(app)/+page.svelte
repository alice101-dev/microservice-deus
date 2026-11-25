<script lang="ts">
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { rupiah, sumAmounts, tanggal } from "#lib/format.ts";
  import { session } from "#lib/session.svelte.ts";

  let { data } = $props();

  const lineTotal = (codes: string[]) =>
    sumAmounts(
      [data.sheet.assets, data.sheet.liabilities].flatMap((section) =>
        section.groups.flatMap((group) =>
          group.lines.filter((line) => line.code && codes.includes(line.code)).map((line) => line.amount),
        ),
      ),
    );
  const cash = $derived(lineTotal(["1-1000", "1-1100"]));
  const receivable = $derived(lineTotal(["1-1200"]));
  const payable = $derived(lineTotal(["2-1000"]));
  const overdue = $derived(
    data.invoices.filter((invoice) => invoice.dueDate < data.asOf && invoice.amountDue !== "0.00"),
  );
  const billsDue = $derived(
    data.bills.filter((bill) => bill.amountDue !== "0.00").sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
  );
</script>

<PageHeader title="Beranda" description={`${session.organization?.name ?? ""} · per ${tanggal(data.asOf)}`} />

<section class="kpis">
  <div class="card"><span class="muted">Kas & bank</span><strong>{rupiah(cash)}</strong></div>
  <div class="card"><span class="muted">Piutang usaha</span><strong>{rupiah(receivable)}</strong></div>
  <div class="card"><span class="muted">Utang usaha</span><strong>{rupiah(payable)}</strong></div>
  <div class="card">
    <span class="muted">Laba bulan ini</span><strong class:negative={data.income.netIncome.startsWith("-")}
      >{rupiah(data.income.netIncome)}</strong
    >
  </div>
</section>

<div class="grid-2">
  <section class="card stack">
    <div class="row between">
      <h2>Invoice jatuh tempo</h2>
      <a href="/sales">Semua invoice</a>
    </div>
    {#if overdue.length === 0}
      <p class="muted">Tidak ada invoice yang lewat jatuh tempo.</p>
    {:else}
      <table>
        <tbody>
          {#each overdue.slice(0, 8) as invoice (invoice.id)}
            <tr>
              <td><a href={`/sales/${invoice.id}`}>{invoice.number}</a><br /><small class="muted">{invoice.contactName}</small></td>
              <td><small class="muted">{tanggal(invoice.dueDate)}</small></td>
              <td class="num">{rupiah(invoice.amountDue)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>
  <section class="card stack">
    <div class="row between">
      <h2>Tagihan yang harus dibayar</h2>
      <a href="/purchases">Semua tagihan</a>
    </div>
    {#if billsDue.length === 0}
      <p class="muted">Tidak ada tagihan terbuka.</p>
    {:else}
      <table>
        <tbody>
          {#each billsDue.slice(0, 8) as bill (bill.id)}
            <tr>
              <td><a href={`/purchases/${bill.id}`}>{bill.number}</a><br /><small class="muted">{bill.contactName}</small></td>
              <td><small class="muted">{tanggal(bill.dueDate)}</small></td>
              <td class="num">{rupiah(bill.amountDue)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>
</div>

{#if !data.sheet.balanced}
  <p class="muted">Neraca belum seimbang — periksa jurnal yang belum lengkap.</p>
{/if}

<style>
  .kpis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }
  .kpis .card {
    display: grid;
    gap: 0.35rem;
  }
  .kpis strong {
    font-size: 1.35rem;
    font-variant-numeric: tabular-nums;
  }
  .negative {
    color: var(--danger);
  }
  .between {
    justify-content: space-between;
  }
  td {
    padding: 0.5rem 0.25rem;
  }
</style>
