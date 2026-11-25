<script lang="ts">
  import { api, call } from "#lib/api.ts";
  import Alert from "#lib/components/Alert.svelte";
  import Badge from "#lib/components/Badge.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { reportError } from "#lib/errors.ts";
  import { invalidateAll } from "$app/navigation";

  let { data } = $props();
  let open = $state(false);
  let busy = $state(false);
  let error = $state<unknown>(null);
  let form = $state({ name: "", role: "customer", email: "", phone: "", taxId: "", address: "", paymentTermsDays: 30 });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = null;
    try {
      await call(
        api.contacts.post({
          name: form.name,
          isCustomer: form.role !== "vendor",
          isVendor: form.role !== "customer",
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          taxId: form.taxId.trim() || null,
          address: form.address.trim() || null,
          paymentTermsDays: Number(form.paymentTermsDays),
        }),
      );
      open = false;
      form = { name: "", role: "customer", email: "", phone: "", taxId: "", address: "", paymentTermsDays: 30 };
      await invalidateAll();
    } catch (caught) {
      reportError(caught, { "ui.action": "create contact" });
      error = caught;
    } finally {
      busy = false;
    }
  }
</script>

<PageHeader title="Kontak" description="Pelanggan dan pemasok">
  {#snippet actions()}
    <a class="button" class:primary={!data.role} href="/contacts">Semua</a>
    <a class="button" class:primary={data.role === "customer"} href="/contacts?role=customer">Pelanggan</a>
    <a class="button" class:primary={data.role === "vendor"} href="/contacts?role=vendor">Pemasok</a>
    <button type="button" class="primary" onclick={() => (open = true)}>+ Kontak baru</button>
  {/snippet}
</PageHeader>

<div class="table-wrap">
  <table>
    <thead>
      <tr><th>Nama</th><th>Peran</th><th>Email</th><th>NPWP</th><th class="num">Termin</th><th>Status</th></tr>
    </thead>
    <tbody>
      {#each data.contacts as contact (contact.id)}
        <tr>
          <td><strong>{contact.name}</strong>{#if contact.address}<br /><small class="muted">{contact.address}</small>{/if}</td>
          <td>{[contact.isCustomer && "Pelanggan", contact.isVendor && "Pemasok"].filter(Boolean).join(", ")}</td>
          <td>{contact.email ?? "—"}</td>
          <td>{contact.taxId ?? "—"}</td>
          <td class="num">{contact.paymentTermsDays} hari</td>
          <td>{#if !contact.active}<Badge status="void" />{/if}</td>
        </tr>
      {:else}
        <tr><td colspan="6" class="empty">Belum ada kontak.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<Modal bind:open title="Kontak baru">
  <form class="stack" onsubmit={save}>
    <Alert {error} />
    <label>Nama <input required maxlength="200" bind:value={form.name} /></label>
    <label
      >Peran
      <select bind:value={form.role}>
        <option value="customer">Pelanggan</option>
        <option value="vendor">Pemasok</option>
        <option value="both">Pelanggan & pemasok</option>
      </select>
    </label>
    <div class="grid-2">
      <label>Email <input type="email" bind:value={form.email} /></label>
      <label>Telepon <input bind:value={form.phone} /></label>
    </div>
    <div class="grid-2">
      <label>NPWP <input inputmode="numeric" pattern="[0-9]{'{'}15,16{'}'}" bind:value={form.taxId} /></label>
      <label>Termin (hari) <input type="number" min="0" max="365" bind:value={form.paymentTermsDays} /></label>
    </div>
    <label>Alamat <textarea rows="2" bind:value={form.address}></textarea></label>
    <button type="submit" class="primary" disabled={busy}>Simpan</button>
  </form>
</Modal>
