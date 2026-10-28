<script lang="ts">
  import { api, call } from "#lib/api.ts";
  import Alert from "#lib/components/Alert.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { reportError } from "#lib/errors.ts";
  import { rupiah, toAmount } from "#lib/format.ts";
  import { invalidateAll } from "$app/navigation";

  let { data } = $props();
  let open = $state(false);
  let busy = $state(false);
  let error = $state<unknown>(null);
  const empty = () => ({
    sku: "",
    name: "",
    kind: "goods" as "goods" | "service",
    unit: "pcs",
    salePrice: "",
    purchasePrice: "",
    vatRate: "11",
    revenueAccountId: "",
    expenseAccountId: "",
  });
  let form = $state(empty());

  const postable = (types: string[]) => data.accounts.filter((account) => account.postable && account.active && types.includes(account.type));
  const accountName = (id: string | null) => {
    const account = data.accounts.find((entry) => entry.id === id);
    return account ? `${account.code} ${account.name}` : "—";
  };

  async function save(event: SubmitEvent) {
    event.preventDefault();
    error = null;
    const salePrice = form.salePrice ? toAmount(form.salePrice) : null;
    const purchasePrice = form.purchasePrice ? toAmount(form.purchasePrice) : null;
    if ((form.salePrice && !salePrice) || (form.purchasePrice && !purchasePrice)) {
      error = "Harga harus berupa angka, mis. 85000 atau 85.000,50";
      return;
    }
    busy = true;
    try {
      await call(
        api.products.post({
          sku: form.sku,
          name: form.name,
          kind: form.kind,
          unit: form.unit || undefined,
          salePrice,
          purchasePrice,
          vatRate: form.vatRate,
          revenueAccountId: form.revenueAccountId || null,
          expenseAccountId: form.expenseAccountId || null,
        }),
      );
      open = false;
      form = empty();
      await invalidateAll();
    } catch (caught) {
      reportError(caught, { "ui.action": "create product" });
      error = caught;
    } finally {
      busy = false;
    }
  }
</script>

<PageHeader title="Produk & jasa" description="Harga, PPN, dan akun bawaan untuk invoice dan tagihan">
  {#snippet actions()}
    <button type="button" class="primary" onclick={() => (open = true)}>+ Produk baru</button>
  {/snippet}
</PageHeader>

<div class="table-wrap">
  <table>
    <thead>
      <tr><th>SKU</th><th>Nama</th><th class="num">Harga jual</th><th class="num">Harga beli</th><th class="num">PPN</th><th>Akun pendapatan</th></tr>
    </thead>
    <tbody>
      {#each data.products as product (product.id)}
        <tr>
          <td><code>{product.sku}</code></td>
          <td>{product.name}<br /><small class="muted">{product.kind === "goods" ? "Barang" : "Jasa"} · {product.unit}</small></td>
          <td class="num">{rupiah(product.salePrice)}</td>
          <td class="num">{rupiah(product.purchasePrice)}</td>
          <td class="num">{Number(product.vatRate)}%</td>
          <td>{accountName(product.revenueAccountId)}</td>
        </tr>
      {:else}
        <tr><td colspan="6" class="empty">Belum ada produk.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<Modal bind:open title="Produk baru">
  <form class="stack" onsubmit={save}>
    <Alert {error} />
    <div class="grid-2">
      <label>SKU <input required pattern="[0-9A-Za-z][0-9A-Za-z._\-]{'{'}0,39{'}'}" bind:value={form.sku} /></label>
      <label
        >Jenis
        <select bind:value={form.kind}>
          <option value="goods">Barang</option>
          <option value="service">Jasa</option>
        </select>
      </label>
    </div>
    <label>Nama <input required maxlength="200" bind:value={form.name} /></label>
    <div class="grid-2">
      <label>Harga jual <input inputmode="decimal" bind:value={form.salePrice} placeholder="85000" /></label>
      <label>Harga beli <input inputmode="decimal" bind:value={form.purchasePrice} /></label>
      <label>Satuan <input maxlength="20" bind:value={form.unit} /></label>
      <label>PPN (%) <input inputmode="decimal" required bind:value={form.vatRate} /></label>
    </div>
    <label
      >Akun pendapatan
      <select bind:value={form.revenueAccountId}>
        <option value="">—</option>
        {#each postable(["revenue"]) as account (account.id)}<option value={account.id}>{account.code} {account.name}</option>{/each}
      </select>
    </label>
    <label
      >Akun beban / persediaan
      <select bind:value={form.expenseAccountId}>
        <option value="">—</option>
        {#each postable(["expense", "asset"]) as account (account.id)}<option value={account.id}>{account.code} {account.name}</option>{/each}
      </select>
    </label>
    <button type="submit" class="primary" disabled={busy}>Simpan</button>
  </form>
</Modal>
