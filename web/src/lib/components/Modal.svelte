<script lang="ts">
  import type { Snippet } from "svelte";

  let { open = $bindable(false), title, children }: { open?: boolean; title: string; children: Snippet } = $props();
  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close();
  });
</script>

<dialog bind:this={dialog} onclose={() => (open = false)} aria-label={title}>
  {#if open}
    <header>
      <h2>{title}</h2>
      <button type="button" aria-label="Tutup" onclick={() => (open = false)}>✕</button>
    </header>
    {@render children()}
  {/if}
</dialog>

<style>
  dialog {
    border: none;
    border-radius: 14px;
    padding: 1.25rem;
    width: min(560px, calc(100vw - 2rem));
    box-shadow: 0 20px 50px rgb(0 0 0 / 20%);
  }
  dialog::backdrop {
    background: rgb(16 24 20 / 35%);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }
  header button {
    border: none;
    padding: 0.25rem 0.5rem;
  }
</style>
