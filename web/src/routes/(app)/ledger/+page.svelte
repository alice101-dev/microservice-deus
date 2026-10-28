<script lang="ts">
  import { api, call } from "#lib/api.ts";
  import Alert from "#lib/components/Alert.svelte";
  import Badge from "#lib/components/Badge.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { reportError } from "#lib/errors.ts";
  import { rupiah, sumAmounts, tanggal, toAmount, today } from "#lib/format.ts";
  import { invalidateAll } from "$app/navigation";

  let { data } = $props();
  const SOURCES: Record<string, string> = {
    manual: "Manual",
    sales: "Penjualan",
    purchases: "Pembelian",
    payments: "Pembayaran",
    banking: "Bank",
    tax: "Pajak",
    reversal: "Pembalikan",
  };
  const accountName = (id: string) => {
    const account = data.accounts.find((entry) => entry.id === id);
    return account ? `${account.code} ${account.name}` : id;
  };
  const postable = $derived(data.accounts.filter((account) => account.postable && account.active));

  let open = $state(false);
  let busy = $state(false);
  let error = $state<unknown>(null);
  const blank = () => ({ key: crypto.randomUUID(), accountId: "", debit: "", credit: "" });
  let form = $state({ date: today(), description: "", lines: [blank(), blank()] });
  const debit = $derived(sumAmounts(form.lines.map((line) => toAmount(line.debit) ?? "0")));
  const credit = $derived(sumAmounts(form.lines.map((line) => toAmount(line.credit) ?? "0")));

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (debit !== credit) {
      error = "Total debit dan kredit harus sama";
      return;
    }
    busy = true;
    error = null;
    try {
      await call(
        api.ledger.journals.post({
          date: form.date,
          description: form.description,
          lines: form.lines
            .filter((line) => line.accountId)
            .map((line) => ({
              accountId: line.accountId,
              ...(toAmount(line.debit) ? { debit: toAmount(line.debit) ?? "0" } : {}),
              ...(toAmount(line.credit) ? { credit: toAmount(line.credit) ?? "0" } : {}),
            })),
        }),
      );
      open = false;
      form = { date: today(), description: "", lines: [blank(), blank()] };
      await invalidateAll();
    } catch (caught) {
      reportError(caught, { "ui.action": "create journal" });
      error = caught;
    } finally {
      busy = false;
    }
  }

  async function reverse(id: string) {
    if (!confirm("Buat jurnal pembalik untuk jurnal ini?")) return;
    try {
      await call(api.ledger.journals({ id }).reverse.post({}));
      await invalidateAll();
    } catch (caught) {
      reportError(caught, { "ui.action": "reverse journal" });
      error = caught;
    }
  }
</script>

<PageHeader title="Jurnal umum" description="Semua jurnal dari penjualan, pembelian, pembayaran, bank, pajak, dan manual">
  {#snippet actions()}
    <a class="button" href="/ledger/trial-balance">Neraca saldo</a>
    <button type="button" class="primary" onclick={() => (open = true)}>+ Jurnal manual</button>
  {/snippet}
</PageHeader>

<form class="row" method="get">
  <label>Dari <input type="date" name="from" value={data.from} /></label>
  <label>Sampai <input type="date" name="to" value={data.to} /></label>
  <button type="submit">Tampilkan</button>
</form>

{#if !open}<Alert {error} />{/if}

<div class="stack">
  {#each data.journals as journal (journal.id)}
    <article class="card">
      <header class="row">
        <strong>{tanggal(journal.date)}</strong>
        <span>{journal.description}</span>
        <span class="muted">{SOURCES[journal.source] ?? journal.source}</span>
        <Badge status={journal.status} />
        {#if journal.status === "posted" && !journal.reversalOf && journal.source === "manual"}
          <button type="button" class="push" onclick={() => reverse(journal.id)}>Balik</button>
        {/if}
      </header>
      <table>
        <tbody>
          {#each journal.lines as line (line.lineNo)}
            <tr>
              <td class:credit={line.credit !== "0.00"}>{accountName(line.accountId)}</td>
              <td class="num">{line.debit !== "0.00" ? rupiah(line.debit) : ""}</td>
              <td class="num">{line.credit !== "0.00" ? rupiah(line.credit) : ""}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </article>
  {:else}
    <p class="empty">Belum ada jurnal pada periode ini.</p>
  {/each}
</div>

<Modal bind:open title="Jurnal manual">
  <form class="stack" onsubmit={save}>
    <Alert {error} />
    <div class="grid-2">
      <label>Tanggal <input type="date" required bind:value={form.date} /></label>
      <label>Keterangan <input required maxlength="500" bind:value={form.description} /></label>
    </div>
    {#each form.lines as line (line.key)}
      <div class="line">
        <select aria-label="Akun" bind:value={line.accountId}>
          <option value="">Pilih akun</option>
          {#each postable as account (account.id)}<option value={account.id}>{account.code} {account.name}</option>{/each}
        </select>
        <input aria-label="Debit" inputmode="decimal" placeholder="Debit" bind:value={line.debit} />
        <input aria-label="Kredit" inputmode="decimal" placeholder="Kredit" bind:value={line.credit} />
      </div>
    {/each}
    <div class="row">
      <button type="button" onclick={() => form.lines.push(blank())}>+ Baris</button>
      <span class="push" class:unbalanced={debit !== credit}>Debit {rupiah(debit)} · Kredit {rupiah(credit)}</span>
    </div>
    <button type="submit" class="primary" disabled={busy || debit !== credit || debit === "0.00"}>Posting</button>
  </form>
</Modal>

<style>
  article header {
    margin-bottom: 0.5rem;
  }
  article td {
    padding: 0.3rem 0.5rem;
  }
  .credit {
    padding-left: 2rem;
  }
  .push {
    margin-left: auto;
  }
  .line {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr;
    gap: 0.5rem;
  }
  .unbalanced {
    color: var(--danger);
    font-weight: 600;
  }
</style>
