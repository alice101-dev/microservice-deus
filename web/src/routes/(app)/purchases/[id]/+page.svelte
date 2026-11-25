<script lang="ts">
  import { api, call } from "#lib/api.ts";
  import Alert from "#lib/components/Alert.svelte";
  import Badge from "#lib/components/Badge.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { reportError } from "#lib/errors.ts";
  import { rupiah, tanggal } from "#lib/format.ts";
  import { goto, invalidateAll } from "$app/navigation";

  let { data } = $props();
  const bill = $derived(data.bill);
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

  const approve = () => run("approve bill", () => call(api.purchases.bills({ id: bill.id }).approve.post()));
  const remove = () =>
    confirm("Hapus draf tagihan ini?") &&
    run("delete bill", () => call(api.purchases.bills({ id: bill.id }).delete()), () => goto("/purchases"));
  const voidBill = () =>
    confirm("Batalkan tagihan ini? Jurnalnya akan dibalik.") &&
    run("void bill", () => call(api.purchases.bills({ id: bill.id }).void.post({})));
</script>

<PageHeader
  title={bill.number ?? "Draf tagihan"}
  description={`${bill.contactName}${bill.vendorReference ? ` · faktur ${bill.vendorReference}` : ""} · ${tanggal(bill.billDate)}`}
>
  {#snippet actions()}
    <Badge status={bill.status} />
    {#if bill.status === "approved"}<Badge status={bill.paymentStatus} />{/if}
    {#if bill.status === "draft"}
      <button type="button" class="danger" disabled={busy} onclick={remove}>Hapus</button>
      <button type="button" class="primary" disabled={busy} onclick={approve}>Setujui</button>
    {/if}
    {#if bill.status === "approved" && bill.amountDue !== "0.00"}
      {#if bill.amountPaid === "0.00"}<button type="button" class="danger" disabled={busy} onclick={voidBill}>Batalkan</button>{/if}
      <a class="button primary" href={`/payments/new?kind=disbursement&document=${bill.id}`}>Catat pembayaran</a>
    {/if}
  {/snippet}
</PageHeader>

<Alert {error} />

<section class="card grid-2">
  <div><span class="muted">Jatuh tempo</span><br /><strong>{tanggal(bill.dueDate)}</strong></div>
  <div><span class="muted">Sudah dibayar</span><br /><strong>{rupiah(bill.amountPaid)}</strong></div>
  <div><span class="muted">Sisa utang</span><br /><strong>{rupiah(bill.amountDue)}</strong></div>
  {#if bill.notes}<div><span class="muted">Catatan</span><br />{bill.notes}</div>{/if}
</section>

<div class="table-wrap">
  <table>
    <thead>
      <tr><th>Keterangan</th><th class="num">Jumlah</th><th class="num">Harga</th><th class="num">PPN</th><th>Akun</th><th class="num">Total</th></tr>
    </thead>
    <tbody>
      {#each bill.lines as line (line.lineNo)}
        <tr>
          <td>{line.description}</td>
          <td class="num">{line.quantity}</td>
          <td class="num">{rupiah(line.unitPrice)}</td>
          <td class="num">{Number(line.vatRate)}%</td>
          <td><small>{accountName(line.accountId)}</small></td>
          <td class="num">{rupiah(line.amount)}</td>
        </tr>
      {/each}
    </tbody>
    <tfoot>
      <tr><td colspan="5" class="num">Subtotal</td><td class="num">{rupiah(bill.subtotal)}</td></tr>
      <tr><td colspan="5" class="num">PPN</td><td class="num">{rupiah(bill.vatTotal)}</td></tr>
      <tr><td colspan="5" class="num"><strong>Total</strong></td><td class="num"><strong>{rupiah(bill.total)}</strong></td></tr>
    </tfoot>
  </table>
</div>
