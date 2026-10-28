<script lang="ts">
  import { api, call } from "#lib/api.ts";
  import Alert from "#lib/components/Alert.svelte";
  import Badge from "#lib/components/Badge.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { reportError } from "#lib/errors.ts";
  import { currentPeriod, rupiah, tanggal } from "#lib/format.ts";
  import { invalidateAll } from "$app/navigation";

  let { data } = $props();
  let period = $state(currentPeriod());
  let busy = $state(false);
  let error = $state<unknown>(null);

  async function run(action: string, work: () => Promise<unknown>) {
    busy = true;
    error = null;
    try {
      await work();
      await invalidateAll();
    } catch (caught) {
      reportError(caught, { "ui.action": action });
      error = caught;
    } finally {
      busy = false;
    }
  }
</script>

<PageHeader title="Pajak (PPN)" description="SPT Masa PPN dihitung dari saldo PPN Keluaran dan PPN Masukan">
  {#snippet actions()}
    <input type="month" aria-label="Masa pajak" bind:value={period} />
    <button type="button" class="primary" disabled={busy} onclick={() => run("calculate vat", () => call(api.tax["vat-returns"].post({ period })))}
      >Hitung</button
    >
  {/snippet}
</PageHeader>

<Alert {error} />

<div class="table-wrap">
  <table>
    <thead>
      <tr><th>Masa</th><th class="num">PPN Keluaran</th><th class="num">PPN Masukan</th><th class="num">Kurang bayar</th><th class="num">Lebih bayar</th><th>Status</th><th></th></tr>
    </thead>
    <tbody>
      {#each data.returns as entry (entry.id)}
        <tr>
          <td>{entry.period}</td>
          <td class="num">{rupiah(entry.outputVat)}</td>
          <td class="num">{rupiah(entry.inputVat)}</td>
          <td class="num">{rupiah(entry.payable)}</td>
          <td class="num">{rupiah(entry.carriedForward)}</td>
          <td><Badge status={entry.status} />{#if entry.filedAt}<br /><small class="muted">{tanggal(entry.filedAt)}</small>{/if}</td>
          <td class="num">
            {#if entry.status === "draft"}
              <button type="button" disabled={busy} onclick={() => run("recalculate vat", () => call(api.tax["vat-returns"].post({ period: entry.period })))}
                >Hitung ulang</button
              >
              <button type="button"
                class="primary"
                disabled={busy}
                onclick={() =>
                  confirm(`Laporkan SPT Masa PPN ${entry.period}? Jurnal penyelesaian akan diposting.`) &&
                  run("file vat", () => call(api.tax["vat-returns"]({ period: entry.period }).file.post()))}>Laporkan</button
              >
            {/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="7" class="empty">Belum ada perhitungan. Pilih masa pajak lalu klik Hitung.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
