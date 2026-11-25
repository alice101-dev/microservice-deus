<script lang="ts">
  import { fromCents } from "@deus/money";
  import { rupiah } from "#lib/format.ts";
  import {
    applyProduct,
    blankLine,
    documentTotals,
    type EditableLine,
    lineTotals,
    type ProductOption,
  } from "#lib/lines.ts";

  interface AccountOption {
    id: string;
    code: string;
    name: string;
  }

  let {
    lines = $bindable(),
    products,
    accounts,
    side,
  }: { lines: EditableLine[]; products: ProductOption[]; accounts: AccountOption[]; side: "sale" | "purchase" } = $props();

  const totals = $derived(documentTotals(lines));

  function chooseProduct(index: number, productId: string) {
    const line = lines[index];
    if (!line) return;
    lines[index] = applyProduct(line, products.find((product) => product.id === productId), side);
  }

  function amountOf(line: EditableLine) {
    const computed = lineTotals(line);
    return computed ? rupiah(fromCents(computed.amount)) : "—";
  }
</script>

<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Produk</th>
        <th>Keterangan</th>
        <th class="num">Jumlah</th>
        <th class="num">Harga satuan</th>
        <th class="num">PPN %</th>
        <th>Akun</th>
        <th class="num">Total</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each lines as line, index (line.key)}
        <tr>
          <td>
            <select
              aria-label="Produk"
              value={line.productId}
              onchange={(event) => chooseProduct(index, (event.currentTarget as HTMLSelectElement).value)}
            >
              <option value="">—</option>
              {#each products as product (product.id)}<option value={product.id}>{product.sku}</option>{/each}
            </select>
          </td>
          <td><input aria-label="Keterangan" bind:value={line.description} /></td>
          <td><input aria-label="Jumlah" class="short" inputmode="decimal" bind:value={line.quantity} /></td>
          <td><input aria-label="Harga satuan" inputmode="decimal" bind:value={line.unitPrice} /></td>
          <td><input aria-label="PPN" class="short" inputmode="decimal" bind:value={line.vatRate} /></td>
          <td>
            <select aria-label="Akun" bind:value={line.accountId}>
              <option value="">—</option>
              {#each accounts as account (account.id)}<option value={account.id}>{account.code} {account.name}</option>{/each}
            </select>
          </td>
          <td class="num">{amountOf(line)}</td>
          <td>
            <button
              type="button"
              aria-label="Hapus baris"
              disabled={lines.length === 1}
              onclick={() => (lines = lines.filter((entry) => entry.key !== line.key))}>✕</button
            >
          </td>
        </tr>
      {/each}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="8"><button type="button" onclick={() => (lines = [...lines, blankLine()])}>+ Tambah baris</button></td>
      </tr>
      <tr><td colspan="6" class="num">Subtotal</td><td class="num">{rupiah(totals.subtotal)}</td><td></td></tr>
      <tr><td colspan="6" class="num">PPN</td><td class="num">{rupiah(totals.vat)}</td><td></td></tr>
      <tr class="total"><td colspan="6" class="num">Total</td><td class="num" data-testid="total">{rupiah(totals.total)}</td><td></td></tr>
    </tfoot>
  </table>
</div>

<style>
  input,
  select {
    width: 100%;
  }
  .short {
    width: 5rem;
  }
  tfoot td {
    border-bottom: none;
  }
  .total td {
    font-weight: 700;
  }
</style>
