<script lang="ts">
  import { api, call } from "#lib/api.ts";
  import Alert from "#lib/components/Alert.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { reportError } from "#lib/errors.ts";
  import { invalidateAll } from "$app/navigation";

  let { data } = $props();
  const TYPES = { asset: "Aset", liability: "Liabilitas", equity: "Ekuitas", revenue: "Pendapatan", expense: "Beban" } as const;
  let open = $state(false);
  let busy = $state(false);
  let error = $state<unknown>(null);
  let form = $state({ code: "", name: "", type: "asset" as keyof typeof TYPES, parentId: "" });

  const depth = (id: string | null): number => {
    const account = data.accounts.find((entry) => entry.id === id);
    return account?.parentId ? 1 + depth(account.parentId) : 0;
  };

  async function createDefaults() {
    busy = true;
    try {
      await call(api.accounts.defaults.post());
      await invalidateAll();
    } catch (caught) {
      reportError(caught, { "ui.action": "default chart" });
      error = caught;
    } finally {
      busy = false;
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = null;
    try {
      await call(
        api.accounts.post({ code: form.code, name: form.name, type: form.type, parentId: form.parentId || undefined }),
      );
      open = false;
      form = { code: "", name: "", type: "asset", parentId: "" };
      await invalidateAll();
    } catch (caught) {
      reportError(caught, { "ui.action": "create account" });
      error = caught;
    } finally {
      busy = false;
    }
  }

  async function toggle(id: string, active: boolean) {
    try {
      await call(api.accounts({ id }).patch({ active: !active }));
      await invalidateAll();
    } catch (caught) {
      reportError(caught, { "ui.action": "toggle account" });
      error = caught;
    }
  }
</script>

<PageHeader title="Bagan akun" description="Akun induk mengelompokkan akun di bawahnya dan tidak bisa diposting">
  {#snippet actions()}
    {#if data.accounts.length === 0}<button type="button" disabled={busy} onclick={createDefaults}>Buat bagan standar</button>{/if}
    <button type="button" class="primary" onclick={() => (open = true)}>+ Akun baru</button>
  {/snippet}
</PageHeader>

{#if !open}<Alert {error} />{/if}

<div class="table-wrap">
  <table>
    <thead><tr><th>Kode</th><th>Nama</th><th>Tipe</th><th></th><th></th></tr></thead>
    <tbody>
      {#each data.accounts as account (account.id)}
        <tr class:inactive={!account.active}>
          <td><code>{account.code}</code></td>
          <td style={`padding-left: ${0.75 + depth(account.id) * 1.25}rem`}>
            {#if account.postable}{account.name}{:else}<strong>{account.name}</strong>{/if}
          </td>
          <td>{TYPES[account.type]}</td>
          <td><small class="muted">{account.postable ? "" : "Akun induk"}</small></td>
          <td class="num"><button type="button" onclick={() => toggle(account.id, account.active)}>{account.active ? "Nonaktifkan" : "Aktifkan"}</button></td>
        </tr>
      {:else}
        <tr><td colspan="5" class="empty">Belum ada akun. Buat bagan standar untuk memulai.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<Modal bind:open title="Akun baru">
  <form class="stack" onsubmit={save}>
    <Alert {error} />
    <div class="grid-2">
      <label>Kode <input required bind:value={form.code} placeholder="1-1110" /></label>
      <label
        >Tipe
        <select bind:value={form.type}>
          {#each Object.entries(TYPES) as [value, label] (value)}<option {value}>{label}</option>{/each}
        </select>
      </label>
    </div>
    <label>Nama <input required maxlength="120" bind:value={form.name} /></label>
    <label
      >Induk
      <select bind:value={form.parentId}>
        <option value="">—</option>
        {#each data.accounts.filter((account) => account.type === form.type) as account (account.id)}
          <option value={account.id}>{account.code} {account.name}</option>
        {/each}
      </select>
    </label>
    <button type="submit" class="primary" disabled={busy}>Simpan</button>
  </form>
</Modal>

<style>
  .inactive {
    opacity: 0.5;
  }
</style>
