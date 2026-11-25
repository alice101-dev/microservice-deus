<script lang="ts">
  import { untrack } from "svelte";
  import { api, call } from "#lib/api.ts";
  import Alert from "#lib/components/Alert.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { reportError } from "#lib/errors.ts";
  import { rupiah, sumAmounts, tanggal, toAmount, today } from "#lib/format.ts";
  import { goto } from "$app/navigation";

  let { data } = $props();
  const initial = untrack(() => data.documents.find((entry) => entry.id === data.document));
  let contactId = $state(initial?.contactId ?? "");
  let date = $state(today());
  let cashAccountId = $state(untrack(() => data.cashAccounts[0]?.id ?? ""));
  let reference = $state("");
  let amounts = $state<Record<string, string>>(initial ? { [initial.id]: initial.amountDue } : {});
  let busy = $state(false);
  let error = $state<unknown>(null);

  const open = $derived(data.documents.filter((entry) => entry.contactId === contactId));
  const allocations = $derived(
    open
      .map((entry) => ({ documentId: entry.id, amount: toAmount(amounts[entry.id] ?? "") }))
      .filter((entry): entry is { documentId: string; amount: string } => entry.amount !== null && entry.amount !== "0"),
  );
  const total = $derived(sumAmounts(allocations.map((allocation) => allocation.amount)));
  const receipt = $derived(data.kind === "receipt");

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (allocations.length === 0) {
      error = "Isi jumlah pada minimal satu dokumen";
      return;
    }
    busy = true;
    error = null;
    try {
      await call(
        api.payments.post({
          kind: data.kind,
          contactId,
          date,
          cashAccountId,
          amount: total,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          allocations,
        }),
      );
      await goto(`/payments?kind=${data.kind}`);
    } catch (caught) {
      reportError(caught, { "ui.action": "record payment" });
      error = caught;
    } finally {
      busy = false;
    }
  }
</script>

<PageHeader
  title={receipt ? "Penerimaan pembayaran" : "Pembayaran ke pemasok"}
  description="Seluruh jumlah dialokasikan ke invoice atau tagihan yang terbuka"
/>

<form class="stack" onsubmit={save}>
  <Alert {error} />
  <div class="card grid-2">
    <label
      >{receipt ? "Pelanggan" : "Pemasok"}
      <select required bind:value={contactId} onchange={() => (amounts = {})}>
        <option value="" disabled>Pilih kontak</option>
        {#each data.contacts as contact (contact.id)}<option value={contact.id}>{contact.name}</option>{/each}
      </select>
    </label>
    <label>Tanggal <input type="date" required bind:value={date} /></label>
    <label
      >{receipt ? "Masuk ke" : "Dibayar dari"}
      <select required bind:value={cashAccountId}>
        {#each data.cashAccounts as account (account.id)}<option value={account.id}>{account.code} {account.name}</option>{/each}
      </select>
    </label>
    <label>Referensi <input maxlength="100" bind:value={reference} placeholder="mis. no. transfer" /></label>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>Dokumen</th><th>Tanggal</th><th>Jatuh tempo</th><th class="num">Sisa</th><th class="num">Dialokasikan</th></tr>
      </thead>
      <tbody>
        {#each open as entry (entry.id)}
          <tr>
            <td>{entry.number}</td>
            <td>{tanggal(entry.date)}</td>
            <td>{tanggal(entry.dueDate)}</td>
            <td class="num">{rupiah(entry.amountDue)}</td>
            <td class="num">
              <input
                aria-label={`Alokasi ${entry.number}`}
                inputmode="decimal"
                bind:value={amounts[entry.id]}
                placeholder="0"
              />
              <button type="button" onclick={() => (amounts[entry.id] = entry.amountDue)}>Lunas</button>
            </td>
          </tr>
        {:else}
          <tr><td colspan="5" class="empty">{contactId ? "Tidak ada dokumen terbuka untuk kontak ini." : "Pilih kontak dulu."}</td></tr>
        {/each}
      </tbody>
      <tfoot>
        <tr><td colspan="4" class="num"><strong>Total pembayaran</strong></td><td class="num"><strong>{rupiah(total)}</strong></td></tr>
      </tfoot>
    </table>
  </div>
  <div class="row">
    <button type="submit" class="primary" disabled={busy || allocations.length === 0}>{busy ? "Menyimpan…" : "Catat"}</button>
    <a class="button" href="/payments">Batal</a>
  </div>
</form>

<style>
  td input {
    width: 9rem;
    text-align: right;
  }
</style>
