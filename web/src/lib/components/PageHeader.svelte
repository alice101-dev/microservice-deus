<script lang="ts">
  import type { Snippet } from "svelte";

  let { title, description, actions }: { title: string; description?: string; actions?: Snippet } = $props();
</script>

<header>
  <div>
    <h1>{title}</h1>
    {#if description}<p class="muted">{description}</p>{/if}
  </div>
  {#if actions}<div class="row">{@render actions()}</div>{/if}
</header>

<style>
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 1rem;
    flex-wrap: wrap;
  }
  p {
    margin: 0.25rem 0 0;
  }
</style>
