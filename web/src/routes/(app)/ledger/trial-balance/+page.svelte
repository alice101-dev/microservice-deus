<script lang="ts">
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { rupiah, tanggal } from "#lib/format.ts";

  let { data } = $props();
</script>

<PageHeader title="Neraca saldo" description={`Per ${tanggal(data.asOf)}`}>
  {#snippet actions()}
    <form class="row" method="get">
      <input type="date" name="asOf" value={data.asOf} aria-label="Per tanggal" />
      <button type="submit">Tampilkan</button>
    </form>
  {/snippet}
</PageHeader>

<div class="table-wrap">
  <table>
    <thead><tr><th>Kode</th><th>Akun</th><th class="num">Debit</th><th class="num">Kredit</th><th class="num">Saldo</th></tr></thead>
    <tbody>
      {#each data.report.rows as row (row.accountId)}
        <tr>
          <td><code>{row.code ?? ""}</code></td>
          <td>{row.name ?? row.accountId}</td>
          <td class="num">{rupiah(row.debit)}</td>
          <td class="num">{rupiah(row.credit)}</td>
          <td class="num">{rupiah(row.balance)}</td>
        </tr>
      {:else}
        <tr><td colspan="5" class="empty">Belum ada jurnal terposting.</td></tr>
      {/each}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="2"><strong>Total</strong> {#if data.report.balanced}<span class="ok">seimbang</span>{:else}<span class="bad">tidak seimbang</span>{/if}</td>
        <td class="num"><strong>{rupiah(data.report.debit)}</strong></td>
        <td class="num"><strong>{rupiah(data.report.credit)}</strong></td>
        <td></td>
      </tr>
    </tfoot>
  </table>
</div>

<style>
  .ok {
    color: var(--primary);
  }
  .bad {
    color: var(--danger);
  }
</style>
