<script lang="ts">
  import Badge from "#lib/components/Badge.svelte";
  import PageHeader from "#lib/components/PageHeader.svelte";
  import { tanggal } from "#lib/format.ts";

  let { data } = $props();
</script>

<PageHeader title="Email terkirim" description="Invoice yang dikirim otomatis ke pelanggan" />

<div class="table-wrap">
  <table>
    <thead><tr><th>Tanggal</th><th>Penerima</th><th>Subjek</th><th>Status</th></tr></thead>
    <tbody>
      {#each data.messages as message (message.id)}
        <tr>
          <td>{tanggal(message.createdAt)}</td>
          <td>{message.recipient}</td>
          <td>{message.subject ?? message.template}{#if message.lastError}<br /><small class="bad">{message.lastError}</small>{/if}</td>
          <td><Badge status={message.status} /></td>
        </tr>
      {:else}
        <tr><td colspan="4" class="empty">Belum ada email.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .bad {
    color: var(--danger);
  }
</style>
