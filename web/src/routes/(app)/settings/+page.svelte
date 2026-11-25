<script lang="ts">
  import { untrack } from "svelte";
  import { api, call } from "#lib/api.ts";
  import Alert from "#lib/components/Alert.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { reportError } from "#lib/errors.ts";
  import { invalidateAll } from "$app/navigation";

  let { data } = $props();
  let form = $state(
    untrack(() => ({
      legalName: data.profile?.legalName ?? "",
      taxId: data.profile?.taxId ?? "",
      address: data.profile?.address ?? "",
      fiscalYearStartMonth: data.profile?.fiscalYearStartMonth ?? 1,
    })),
  );
  let busy = $state(false);
  let error = $state<unknown>(null);
  let saved = $state(false);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = null;
    saved = false;
    try {
      await call(
        api.organization.profile.put({
          legalName: form.legalName,
          taxId: form.taxId.trim() || null,
          address: form.address.trim() || null,
          fiscalYearStartMonth: Number(form.fiscalYearStartMonth),
        }),
      );
      saved = true;
      await invalidateAll();
    } catch (caught) {
      reportError(caught, { "ui.action": "save profile" });
      error = caught;
    } finally {
      busy = false;
    }
  }
</script>

<PageHeader title="Pengaturan" description="Profil perusahaan untuk invoice, laporan, dan pajak" />

<form class="card stack settings" onsubmit={save}>
  <Alert {error} />
  {#if saved}<Alert error="Profil disimpan" tone="info" />{/if}
  <label>Nama badan usaha <input required maxlength="200" bind:value={form.legalName} /></label>
  <label>NPWP <input inputmode="numeric" pattern="[0-9]{'{'}15,16{'}'}" bind:value={form.taxId} /></label>
  <label>Alamat <textarea rows="2" maxlength="500" bind:value={form.address}></textarea></label>
  <label>Bulan awal tahun buku <input type="number" min="1" max="12" bind:value={form.fiscalYearStartMonth} /></label>
  <p class="muted">Mata uang: IDR</p>
  <button type="submit" class="primary" disabled={busy}>Simpan</button>
</form>

<style>
  .settings {
    max-width: 560px;
  }
</style>
