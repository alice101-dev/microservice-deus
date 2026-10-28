<script lang="ts">
  import { ApiError, messageOf } from "#lib/errors.ts";

  let { error, tone = "danger" }: { error: unknown; tone?: "danger" | "info" } = $props();
  const traceId = $derived(error instanceof ApiError ? error.traceId : undefined);
</script>

{#if error}
  <div class="alert {tone}" role="alert">
    <span>{typeof error === "string" ? error : messageOf(error)}</span>
    {#if traceId}<small>Kode jejak: {traceId}</small>{/if}
  </div>
{/if}

<style>
  .alert {
    border-radius: 8px;
    padding: 0.7rem 0.9rem;
    display: grid;
    gap: 0.2rem;
  }
  .danger {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .info {
    background: var(--info-soft);
    color: var(--info);
  }
  small {
    font-family: ui-monospace, monospace;
    opacity: 0.8;
  }
</style>
