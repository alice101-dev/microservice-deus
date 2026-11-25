<script lang="ts">
  import { api, call } from "#lib/api.ts";
  import Alert from "#lib/components/Alert.svelte";
  import Badge from "#lib/components/Badge.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { reportError } from "#lib/errors.ts";
  import { rupiah, tanggal } from "#lib/format.ts";
  import { goto, invalidateAll } from "$app/navigation";

  let { data } = $props();
  const invoice = $derived(data.invoice);
  let busy = $state(false);
  let error = $state<unknown>(null);

  const accountName = (id: string) => {
    const account = data.accounts.find((entry) => entry.id === id);
    return account ? `${account.code} ${account.name}` : id;
  };

  async function run(action: string, work: () => Promise<unknown>, after: () => Promise<void> = invalidateAll) {
    busy = true;
    error = null;
    try {
      await work();
      await after();
    } catch (caught) {
      reportError(caught, { "ui.action": action });
      error = caught;
    } finally {
      busy = false;
    }
  }

  const issue = () => run("issue invoice", () => call(api.sales.invoices({ id: invoice.id }).issue.post()));
  const remove = () =>
    confirm("Hapus draf invoice ini?") &&
    run("delete invoice", () => call(api.sales.invoices({ id: invoice.id }).delete()), () => goto("/sales"));
  const voidInvoice = () =>
    confirm("Batalkan invoice ini? Jurnalnya akan dibalik.") &&
    run("void invoice", () => call(api.sales.invoices({ id: invoice.id }).void.post({})));
</script>

<PageHeader title={invoice.number ?? "Draf invoice"} description={`${invoice.contactName} · ${tanggal(invoice.issueDate)}`}>
  {#snippet actions()}
    <Badge status={invoice.status} />
    {#if invoice.status === "issued"}<Badge status={invoice.paymentStatus} />{/if}
    {#if invoice.status === "draft"}
      <button type="button" class="danger" disabled={busy} onclick={remove}>Hapus</button>
      <button type="button" class="primary" disabled={busy} onclick={issue}>Terbitkan</button>
    {/if}
    {#if invoice.status === "issued" && invoice.amountDue !== "0.00"}
      {#if invoice.amountPaid === "0.00"}<button type="button" class="danger" disabled={busy} onclick={voidInvoice}>Batalkan</button>{/if}
      <a class="button primary" href={`/payments/new?kind=receipt&document=${invoice.id}`}>Catat penerimaan</a>
    {/if}
  {/snippet}
</PageHeader>

<Alert {error} />

<section class="card grid-2">
  <div><span class="muted">Jatuh tempo</span><br /><strong>{tanggal(invoice.dueDate)}</strong></div>
  <div><span class="muted">Sudah dibayar</span><br /><strong>{rupiah(invoice.amountPaid)}</strong></div>
  <div><span class="muted">Sisa tagihan</span><br /><strong>{rupiah(invoice.amountDue)}</strong></div>
  {#if invoice.notes}<div><span class="muted">Catatan</span><br />{invoice.notes}</div>{/if}
</section>

<div class="table-wrap">
  <table>
    <thead>
      <tr><th>Keterangan</th><th class="num">Jumlah</th><th class="num">Harga</th><th class="num">PPN</th><th>Akun</th><th class="num">Total</th></tr>
    </thead>
    <tbody>
      {#each invoice.lines as line (line.lineNo)}
        <tr>
          <td>{line.description}</td>
          <td class="num">{line.quantity}</td>
          <td class="num">{rupiah(line.unitPrice)}</td>
          <td class="num">{Number(line.vatRate)}%</td>
          <td><small>{accountName(line.revenueAccountId)}</small></td>
          <td class="num">{rupiah(line.amount)}</td>
        </tr>
      {/each}
    </tbody>
    <tfoot>
      <tr><td colspan="5" class="num">Subtotal</td><td class="num">{rupiah(invoice.subtotal)}</td></tr>
      <tr><td colspan="5" class="num">PPN</td><td class="num">{rupiah(invoice.vatTotal)}</td></tr>
      <tr><td colspan="5" class="num"><strong>Total</strong></td><td class="num"><strong>{rupiah(invoice.total)}</strong></td></tr>
    </tfoot>
  </table>
</div>
