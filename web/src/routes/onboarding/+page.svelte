<script lang="ts">
  import { api, call } from "#lib/api.ts";
  import { authClient } from "#lib/auth.ts";
  import Alert from "#lib/components/Alert.svelte";
  import { reportError } from "#lib/errors.ts";
  import { session } from "#lib/session.svelte.ts";
  import { goto } from "$app/navigation";

  let legalName = $state("");
  let taxId = $state("");
  let address = $state("");
  let fiscalYearStartMonth = $state(1);
  let createChart = $state(true);
  let busy = $state(false);
  let error = $state<unknown>(null);

  const MONTHS = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember",
  ];

  function slugify(value: string) {
    const base = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `${base || "organisasi"}-${crypto.randomUUID().slice(0, 6)}`;
  }

  async function choose(id: string) {
    busy = true;
    try {
      await session.setActive(id);
      await goto("/");
    } catch (caught) {
      error = caught;
    } finally {
      busy = false;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = null;
    try {
      const created = await authClient.organization.create({ name: legalName, slug: slugify(legalName) });
      if (created.error || !created.data) throw new Error(created.error?.message ?? "Gagal membuat organisasi");
      await session.setActive(created.data.id);
      await call(
        api.organization.profile.put({
          legalName,
          taxId: taxId.trim() || null,
          address: address.trim() || null,
          fiscalYearStartMonth,
        }),
      );
      if (createChart) await call(api.accounts.defaults.post());
      await goto("/");
    } catch (caught) {
      reportError(caught, { "ui.action": "onboarding" });
      error = caught;
    } finally {
      busy = false;
    }
  }
</script>

<main>
  <div class="card stack">
    <div>
      <h1>Siapkan perusahaan Anda</h1>
      <p class="muted">Data ini dipakai di invoice, laporan keuangan, dan SPT Masa PPN.</p>
    </div>
    <Alert {error} />
    {#if session.organizations.length > 0}
      <div class="stack">
        <h2>Pilih organisasi</h2>
        {#each session.organizations as organization (organization.id)}
          <button type="button" disabled={busy} onclick={() => choose(organization.id)}>{organization.name}</button>
        {/each}
        <p class="muted">atau buat organisasi baru:</p>
      </div>
    {/if}
    <form class="stack" onsubmit={submit}>
      <label>Nama badan usaha <input required maxlength="200" bind:value={legalName} placeholder="PT Contoh Jaya" /></label>
      <label
        >NPWP <input inputmode="numeric" pattern="[0-9]{'{'}15,16{'}'}" bind:value={taxId} placeholder="15 atau 16 digit" /></label
      >
      <label>Alamat <textarea rows="2" maxlength="500" bind:value={address}></textarea></label>
      <label
        >Awal tahun buku
        <select bind:value={fiscalYearStartMonth}>
          {#each MONTHS as month, index (month)}
            <option value={index + 1}>{month}</option>
          {/each}
        </select>
      </label>
      <label class="check"
        ><input type="checkbox" bind:checked={createChart} /> Buat bagan akun standar UMKM (27 akun)</label
      >
      <button type="submit" class="primary" disabled={busy}>{busy ? "Menyiapkan…" : "Mulai"}</button>
    </form>
  </div>
</main>

<style>
  main {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 1rem;
  }
  .card {
    width: min(520px, 100%);
  }
  .check {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-weight: 500;
  }
</style>
