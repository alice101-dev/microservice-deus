<script lang="ts">
  import Badge from "#lib/components/Badge.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { rupiah, tanggal, today } from "#lib/format.ts";

  let { data } = $props();
  const now = today();
  const FILTERS = [
    { value: null, label: "Semua" },
    { value: "draft", label: "Draf" },
    { value: "issued", label: "Terbit" },
    { value: "void", label: "Batal" },
  ];
</script>

<PageHeader title="Penjualan" description="Invoice ke pelanggan">
  {#snippet actions()}
    {#each FILTERS as filter (filter.label)}
      <a class="button" class:primary={data.status === filter.value} href={filter.value ? `/sales?status=${filter.value}` : "/sales"}
        >{filter.label}</a
      >
    {/each}
    <a class="button primary" href="/sales/new">+ Invoice baru</a>
  {/snippet}
</PageHeader>

<div class="table-wrap">
  <table>
    <thead>
      <tr><th>Nomor</th><th>Pelanggan</th><th>Tanggal</th><th>Jatuh tempo</th><th class="num">Total</th><th class="num">Sisa</th><th>Status</th></tr>
    </thead>
    <tbody>
      {#each data.invoices as invoice (invoice.id)}
        <tr>
          <td><a href={`/sales/${invoice.id}`}>{invoice.number ?? "Draf"}</a></td>
          <td>{invoice.contactName}</td>
          <td>{tanggal(invoice.issueDate)}</td>
          <td class:overdue={invoice.status === "issued" && invoice.amountDue !== "0.00" && invoice.dueDate < now}>{tanggal(invoice.dueDate)}</td>
          <td class="num">{rupiah(invoice.total)}</td>
          <td class="num">{rupiah(invoice.amountDue)}</td>
          <td>
            <Badge status={invoice.status} />
            {#if invoice.status === "issued"}<Badge status={invoice.paymentStatus} />{/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="7" class="empty">Belum ada invoice.</td></tr>
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
