<script lang="ts">
  import { api, call } from "#lib/api.ts";
  import Alert from "#lib/components/Alert.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { reportError } from "#lib/errors.ts";
  import { rupiah, tanggal, toAmount, today } from "#lib/format.ts";
  import { invalidateAll } from "$app/navigation";

  let { data } = $props();
  let open = $state(false);
  let busy = $state(false);
  let error = $state<unknown>(null);
  const blank = () => ({ name: "", bankName: "", accountNumber: "", ledgerAccountId: "", openingBalance: "0", openingDate: today() });
  let form = $state(blank());
  const linked = $derived(new Set(data.bankAccounts.map((account) => account.ledgerAccountId)));
  const candidates = $derived(
    data.accounts.filter((account) => account.type === "asset" && account.postable && account.active && !linked.has(account.id)),
  );
  const accountName = (id: string) => {
    const account = data.accounts.find((entry) => entry.id === id);
    return account ? `${account.code} ${account.name}` : id;
  };

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const openingBalance = toAmount(form.openingBalance);
    if (!openingBalance) {
      error = "Saldo awal harus berupa angka";
      return;
    }
    busy = true;
    error = null;
    try {
      await call(api.banking.accounts.post({ ...form, openingBalance }));
      open = false;
      form = blank();
      await invalidateAll();
    } catch (caught) {
      reportError(caught, { "ui.action": "create bank account" });
      error = caught;
    } finally {
      busy = false;
    }
  }
</script>

<PageHeader title="Bank" description="Impor mutasi rekening, cocokkan dengan pembayaran, dan rekonsiliasi">
  {#snippet actions()}
    <button type="button" class="primary" onclick={() => (open = true)}>+ Rekening</button>
  {/snippet}
</PageHeader>

<div class="table-wrap">
  <table>
    <thead><tr><th>Rekening</th><th>Bank</th><th>No. rekening</th><th>Akun buku besar</th><th class="num">Saldo awal</th></tr></thead>
    <tbody>
      {#each data.bankAccounts as account (account.id)}
        <tr>
          <td><a href={`/banking/${account.id}`}>{account.name}</a></td>
          <td>{account.bankName}</td>
          <td><code>{account.accountNumber}</code></td>
          <td>{accountName(account.ledgerAccountId)}</td>
          <td class="num">{rupiah(account.openingBalance)}<br /><small class="muted">{tanggal(account.openingDate)}</small></td>
        </tr>
      {:else}
        <tr><td colspan="5" class="empty">Belum ada rekening.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<Modal bind:open title="Rekening bank">
  <form class="stack" onsubmit={save}>
    <Alert {error} />
    <label>Nama <input required maxlength="100" bind:value={form.name} placeholder="BCA Operasional" /></label>
    <div class="grid-2">
      <label>Bank <input required maxlength="100" bind:value={form.bankName} /></label>
      <label>No. rekening <input required pattern="[0-9 \-]{'{'}4,40{'}'}" bind:value={form.accountNumber} /></label>
    </div>
    <label
      >Akun buku besar
      <select required bind:value={form.ledgerAccountId}>
        <option value="" disabled>Pilih akun aset</option>
        {#each candidates as account (account.id)}<option value={account.id}>{account.code} {account.name}</option>{/each}
      </select>
    </label>
    <div class="grid-2">
      <label>Saldo awal <input inputmode="decimal" bind:value={form.openingBalance} /></label>
      <label>Per tanggal <input type="date" required bind:value={form.openingDate} /></label>
    </div>
    <button type="submit" class="primary" disabled={busy}>Simpan</button>
  </form>
</Modal>
