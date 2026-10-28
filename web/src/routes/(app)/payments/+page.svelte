<script lang="ts">
  import { api, call } from "#lib/api.ts";
  import Alert from "#lib/components/Alert.svelte";
  import Badge from "#lib/components/Badge.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { reportError } from "#lib/errors.ts";
  import { rupiah, tanggal } from "#lib/format.ts";
  import { invalidateAll } from "$app/navigation";

  let { data } = $props();
  let error = $state<unknown>(null);

  async function voidPayment(id: string, number: string) {
    if (!confirm(`Batalkan ${number}? Jurnal dan alokasinya akan dibalik.`)) return;
    error = null;
    try {
      await call(api.payments({ id }).void.post({}));
      await invalidateAll();
    } catch (caught) {
      reportError(caught, { "ui.action": "void payment" });
      error = caught;
    }
  }
</script>

<PageHeader title="Pembayaran" description="Penerimaan dari pelanggan dan pembayaran ke pemasok">
  {#snippet actions()}
    <a class="button" class:primary={!data.kind} href="/payments">Semua</a>
    <a class="button" class:primary={data.kind === "receipt"} href="/payments?kind=receipt">Penerimaan</a>
    <a class="button" class:primary={data.kind === "disbursement"} href="/payments?kind=disbursement">Pengeluaran</a>
    <a class="button primary" href="/payments/new?kind=receipt">+ Penerimaan</a>
    <a class="button primary" href="/payments/new?kind=disbursement">+ Pembayaran</a>
  {/snippet}
</PageHeader>

<Alert {error} />

<div class="table-wrap">
  <table>
    <thead>
      <tr><th>Nomor</th><th>Kontak</th><th>Tanggal</th><th>Dialokasikan ke</th><th class="num">Jumlah</th><th>Status</th><th></th></tr>
    </thead>
    <tbody>
      {#each data.payments as payment (payment.id)}
        <tr>
          <td>{payment.number}<br /><small class="muted">{payment.kind === "receipt" ? "Penerimaan" : "Pembayaran"}</small></td>
          <td>{payment.contactName}</td>
          <td>{tanggal(payment.date)}</td>
          <td><small>{payment.allocations.map((allocation) => allocation.documentNumber).join(", ")}</small></td>
          <td class="num">{rupiah(payment.amount)}</td>
          <td><Badge status={payment.status} /></td>
          <td class="num">
            {#if payment.status === "recorded"}<button type="button" class="danger" onclick={() => voidPayment(payment.id, payment.number)}>Batalkan</button>{/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="7" class="empty">Belum ada pembayaran.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
