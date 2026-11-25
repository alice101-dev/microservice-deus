<script lang="ts">
  import { api, call } from "#lib/api.ts";
  import Alert from "#lib/components/Alert.svelte";
  import Badge from "#lib/components/Badge.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { statementRows } from "#lib/csv.ts";
  import { reportError } from "#lib/errors.ts";
  import { rupiah, tanggal } from "#lib/format.ts";
  import { invalidateAll } from "$app/navigation";

  let { data } = $props();
  let busy = $state(false);
  let error = $state<unknown>(null);
  let notice = $state<string | null>(null);
  let choice = $state<Record<string, string>>({});

  const matchedPayments = $derived(new Set(data.lines.map((line) => line.paymentId).filter(Boolean)));
  const candidates = (amount: string) => {
    const incoming = !amount.startsWith("-");
    const absolute = amount.replace(/^-/, "");
    return data.payments.filter(
      (payment) =>
        !matchedPayments.has(payment.id) &&
        payment.amount === absolute &&
        (payment.kind === "receipt") === incoming,
    );
  };

  async function run(action: string, work: () => Promise<unknown>) {
    busy = true;
    error = null;
    try {
      await work();
      await invalidateAll();
    } catch (caught) {
      reportError(caught, { "ui.action": action });
      error = caught;
    } finally {
      busy = false;
    }
  }

  async function importFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const { rows, errors } = statementRows(await file.text());
    input.value = "";
    if (rows.length === 0) {
      error = errors.join(" · ") || "Tidak ada baris yang bisa diimpor";
      return;
    }
    await run("import statement", async () => {
      const result = await call(api.banking.accounts({ id: data.bank.id }).statements.post({ lines: rows }));
      notice = `${result.imported} baris diimpor, ${result.duplicates} sudah ada${errors.length ? `, ${errors.length} dilewati` : ""}.`;
    });
  }

  function resolve(lineId: string, value: string) {
    if (!value) return;
    const [kind, id] = value.split(":") as [string, string];
    if (kind === "payment") return run("match line", () => call(api.banking.lines({ id: lineId }).match.post({ paymentId: id })));
    return run("post line", () => call(api.banking.lines({ id: lineId }).post.post({ accountId: id })));
  }
</script>

<PageHeader title={data.bank.name} description={`${data.bank.bankName} · ${data.bank.accountNumber}`}>
  {#snippet actions()}
    <label class="button">
      Impor CSV
      <input type="file" accept=".csv,text/csv" hidden onchange={importFile} />
    </label>
  {/snippet}
</PageHeader>

<Alert {error} />
<Alert error={notice} tone="info" />

<section class="card grid-2">
  <div><span class="muted">Saldo menurut bank</span><br /><strong>{rupiah(data.reconciliation.statementBalance)}</strong></div>
  <div><span class="muted">Saldo menurut buku</span><br /><strong>{rupiah(data.reconciliation.ledgerBalance)}</strong></div>
  <div>
    <span class="muted">Selisih per {tanggal(data.asOf)}</span><br /><strong class:bad={!data.reconciliation.reconciled}
      >{rupiah(data.reconciliation.difference)}</strong
    >
  </div>
  <div>
    <span class="muted">Status</span><br /><strong>{data.reconciliation.reconciled ? "Terekonsiliasi" : `${data.reconciliation.unmatched.length} baris belum cocok`}</strong>
  </div>
</section>

<div class="table-wrap">
  <table>
    <thead><tr><th>Tanggal</th><th>Keterangan</th><th class="num">Jumlah</th><th>Status</th><th>Tindakan</th></tr></thead>
    <tbody>
      {#each data.lines as line (line.id)}
        <tr>
          <td>{tanggal(line.date)}</td>
          <td>{line.description}{#if line.reference}<br /><small class="muted">{line.reference}</small>{/if}</td>
          <td class="num" class:out={line.amount.startsWith("-")}>{rupiah(line.amount)}</td>
          <td><Badge status={line.status} /></td>
          <td>
            {#if line.status === "unmatched"}
              <div class="row">
                <select aria-label="Cocokkan" bind:value={choice[line.id]}>
                  <option value="">Pilih…</option>
                  {#if candidates(line.amount).length}
                    <optgroup label="Pembayaran">
                      {#each candidates(line.amount) as payment (payment.id)}
                        <option value={`payment:${payment.id}`}>{payment.number} · {payment.contactName}</option>
                      {/each}
                    </optgroup>
                  {/if}
                  <optgroup label="Posting ke akun">
                    {#each data.accounts as account (account.id)}<option value={`account:${account.id}`}>{account.code} {account.name}</option>{/each}
                  </optgroup>
                </select>
                <button type="button" disabled={busy || !choice[line.id]} onclick={() => resolve(line.id, choice[line.id] ?? "")}>Simpan</button>
                <button type="button" disabled={busy} onclick={() => run("ignore line", () => call(api.banking.lines({ id: line.id }).ignore.post()))}
                  >Abaikan</button
                >
              </div>
            {:else if line.status === "matched" || line.status === "ignored"}
              <button type="button" disabled={busy} onclick={() => run("reopen line", () => call(api.banking.lines({ id: line.id }).unmatch.post()))}
                >Buka lagi</button
              >
            {/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="5" class="empty">Belum ada mutasi. Impor file CSV dari internet banking.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .out {
    color: var(--danger);
  }
  .bad {
    color: var(--danger);
  }
</style>
