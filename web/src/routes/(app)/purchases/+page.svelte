<script lang="ts">
  import Badge from "#lib/components/Badge.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { rupiah, tanggal, today } from "#lib/format.ts";

  let { data } = $props();
  const now = today();
  const FILTERS = [
    { value: null, label: "Semua" },
    { value: "draft", label: "Draf" },
    { value: "approved", label: "Disetujui" },
    { value: "void", label: "Batal" },
  ];
</script>

<PageHeader title="Pembelian" description="Tagihan dari pemasok">
  {#snippet actions()}
    {#each FILTERS as filter (filter.label)}
      <a class="button" class:primary={data.status === filter.value} href={filter.value ? `/purchases?status=${filter.value}` : "/purchases"}
        >{filter.label}</a
      >
    {/each}
    <a class="button primary" href="/purchases/new">+ Tagihan baru</a>
  {/snippet}
</PageHeader>

<div class="table-wrap">
  <table>
    <thead>
      <tr><th>Nomor</th><th>Pemasok</th><th>No. faktur pemasok</th><th>Tanggal</th><th>Jatuh tempo</th><th class="num">Total</th><th class="num">Sisa</th><th>Status</th></tr>
    </thead>
    <tbody>
      {#each data.bills as bill (bill.id)}
        <tr>
          <td><a href={`/purchases/${bill.id}`}>{bill.number ?? "Draf"}</a></td>
          <td>{bill.contactName}</td>
          <td>{bill.vendorReference ?? "—"}</td>
          <td>{tanggal(bill.billDate)}</td>
          <td class:overdue={bill.status === "approved" && bill.amountDue !== "0.00" && bill.dueDate < now}>{tanggal(bill.dueDate)}</td>
          <td class="num">{rupiah(bill.total)}</td>
          <td class="num">{rupiah(bill.amountDue)}</td>
          <td>
            <Badge status={bill.status} />
            {#if bill.status === "approved"}<Badge status={bill.paymentStatus} />{/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="8" class="empty">Belum ada tagihan.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .overdue {
    color: var(--danger);
    font-weight: 600;
  }
</style>
