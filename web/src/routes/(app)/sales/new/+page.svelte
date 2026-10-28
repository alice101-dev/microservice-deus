<script lang="ts">
  import { api, call } from "#lib/api.ts";
  import Alert from "#lib/components/Alert.svelte";
  import LinesEditor from "#lib/components/LinesEditor.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { reportError } from "#lib/errors.ts";
  import { today } from "#lib/format.ts";
  import { blankLine, toRequestLines } from "#lib/lines.ts";
  import { goto } from "$app/navigation";

  let { data } = $props();
  let contactId = $state("");
  let issueDate = $state(today());
  let dueDate = $state("");
  let notes = $state("");
  let lines = $state([blankLine()]);
  let busy = $state(false);
  let error = $state<unknown>(null);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const { payload, problems } = toRequestLines(lines);
    if (problems.length > 0) {
      error = problems.join(" · ");
      return;
    }
    busy = true;
    error = null;
    try {
      const invoice = await call(
        api.sales.invoices.post({
          contactId,
          issueDate,
          ...(dueDate ? { dueDate } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          lines: payload.map(({ accountId, ...line }) => ({ ...line, revenueAccountId: accountId })),
        }),
      );
      await goto(`/sales/${invoice.id}`);
    } catch (caught) {
      reportError(caught, { "ui.action": "create invoice" });
      error = caught;
    } finally {
      busy = false;
    }
  }
</script>

<PageHeader title="Invoice baru" description="Disimpan sebagai draf; terbitkan untuk mencatat jurnal dan mengirim email" />

<form class="stack" onsubmit={save}>
  <Alert {error} />
  <div class="card grid-2">
    <label
      >Pelanggan
      <select required bind:value={contactId}>
        <option value="" disabled>Pilih pelanggan</option>
        {#each data.customers as customer (customer.id)}<option value={customer.id}>{customer.name}</option>{/each}
      </select>
    </label>
    <label>Tanggal invoice <input type="date" required bind:value={issueDate} /></label>
    <label>Jatuh tempo <input type="date" bind:value={dueDate} /><small class="muted">Kosongkan untuk memakai termin pelanggan</small></label>
    <label>Catatan <input maxlength="2000" bind:value={notes} placeholder="mis. rekening pembayaran" /></label>
  </div>
  <LinesEditor bind:lines products={data.products} accounts={data.accounts} side="sale" />
  <div class="row">
    <button type="submit" class="primary" disabled={busy}>{busy ? "Menyimpan…" : "Simpan draf"}</button>
    <a class="button" href="/sales">Batal</a>
  </div>
</form>
