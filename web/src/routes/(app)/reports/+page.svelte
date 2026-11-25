<script lang="ts">
  import { api, call } from "#lib/api.ts";
  import Alert from "#lib/components/Alert.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { reportError } from "#lib/errors.ts";
  import { rupiah, tanggal } from "#lib/format.ts";
  import { invalidateAll } from "$app/navigation";
  import Section from "./Section.svelte";

  let { data } = $props();
  let error = $state<unknown>(null);
  let busy = $state(false);

  async function snapshot(kind: "income-statement" | "balance-sheet") {
    busy = true;
    error = null;
    try {
      await call(api.reporting.statements.post(kind === "income-statement" ? { kind, from: data.from, to: data.to } : { kind, to: data.to }));
      await invalidateAll();
    } catch (caught) {
      reportError(caught, { "ui.action": "save statement" });
      error = caught;
    } finally {
      busy = false;
    }
  }
</script>

<PageHeader title="Laporan keuangan" description="Dihitung langsung dari jurnal terposting">
  {#snippet actions()}
    <form class="row" method="get">
      <label>Dari <input type="date" name="from" value={data.from} /></label>
      <label>Sampai <input type="date" name="to" value={data.to} /></label>
      <button type="submit">Tampilkan</button>
    </form>
  {/snippet}
</PageHeader>

<Alert {error} />

<div class="grid-2 reports">
  <section class="card stack">
    <div class="row between">
      <h2>Laba rugi</h2>
      <button type="button" disabled={busy} onclick={() => snapshot("income-statement")}>Simpan</button>
    </div>
    <p class="muted">{tanggal(data.from)} – {tanggal(data.to)}</p>
    <table>
      <Section title="Pendapatan" groups={data.income.revenue.groups} total={data.income.revenue.total} />
      <Section title="Beban" groups={data.income.expense.groups} total={data.income.expense.total} />
      <tfoot>
        <tr class="net"><td>Laba (rugi) bersih</td><td class="num">{rupiah(data.income.netIncome)}</td></tr>
      </tfoot>
    </table>
  </section>
  <section class="card stack">
    <div class="row between">
      <h2>Neraca</h2>
      <button type="button" disabled={busy} onclick={() => snapshot("balance-sheet")}>Simpan</button>
    </div>
    <p class="muted">Per {tanggal(data.to)} · {data.sheet.balanced ? "seimbang" : "tidak seimbang"}</p>
    <table>
      <Section title="Aset" groups={data.sheet.assets.groups} total={data.sheet.assets.total} />
      <Section title="Liabilitas" groups={data.sheet.liabilities.groups} total={data.sheet.liabilities.total} />
      <Section title="Ekuitas" groups={data.sheet.equity.groups} total={data.sheet.equity.total} />
      <tfoot>
        <tr class="net"><td>Liabilitas + ekuitas</td><td class="num">{rupiah(data.sheet.totalLiabilitiesAndEquity)}</td></tr>
      </tfoot>
    </table>
  </section>
</div>

<section class="card stack">
  <h2>Laporan tersimpan</h2>
  {#if data.snapshots.length === 0}
    <p class="muted">Belum ada laporan yang disimpan.</p>
  {:else}
    <table>
      <tbody>
        {#each data.snapshots as snapshot (snapshot.id)}
          <tr>
            <td>{snapshot.kind === "income-statement" ? "Laba rugi" : "Neraca"}</td>
            <td>{snapshot.from ? `${tanggal(snapshot.from)} – ` : "per "}{tanggal(snapshot.to)}</td>
            <td class="muted">disimpan {tanggal(snapshot.createdAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .reports {
    align-items: start;
  }
  .between {
    justify-content: space-between;
  }
  p {
    margin: 0;
  }
  .net td {
    font-weight: 700;
    border-top: 2px solid var(--text);
  }
</style>
