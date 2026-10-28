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
  let billDate = $state(today());
  let dueDate = $state("");
  let vendorReference = $state("");
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
      const bill = await call(
        api.purchases.bills.post({
          contactId,
          billDate,
          ...(dueDate ? { dueDate } : {}),
          ...(vendorReference.trim() ? { vendorReference: vendorReference.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          lines: payload,
        }),
      );
      await goto(`/purchases/${bill.id}`);
    } catch (caught) {
      reportError(caught, { "ui.action": "create bill" });
      error = caught;
    } finally {
      busy = false;
    }
  }
</script>

<PageHeader title="Tagihan baru" description="Disimpan sebagai draf; setujui untuk mencatat utang dan jurnal" />

<form class="stack" onsubmit={save}>
  <Alert {error} />
  <div class="card grid-2">
    <label
      >Pemasok
      <select required bind:value={contactId}>
        <option value="" disabled>Pilih pemasok</option>
        {#each data.vendors as vendor (vendor.id)}<option value={vendor.id}>{vendor.name}</option>{/each}
      </select>
    </label>
    <label>No. faktur pemasok <input maxlength="100" bind:value={vendorReference} /></label>
    <label>Tanggal tagihan <input type="date" required bind:value={billDate} /></label>
    <label>Jatuh tempo <input type="date" bind:value={dueDate} /><small class="muted">Kosongkan untuk memakai termin pemasok</small></label>
    <label>Catatan <input maxlength="2000" bind:value={notes} /></label>
  </div>
  <LinesEditor bind:lines products={data.products} accounts={data.accounts} side="purchase" />
  <div class="row">
    <button type="submit" class="primary" disabled={busy}>{busy ? "Menyimpan…" : "Simpan draf"}</button>
    <a class="button" href="/purchases">Batal</a>
  </div>
</form>
