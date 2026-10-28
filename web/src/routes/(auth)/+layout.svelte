<script lang="ts">
  let { children } = $props();
</script>

<main>
  <div class="brand">
    <svg viewBox="0 0 32 32" width="36" height="36" aria-hidden="true"
      ><rect width="32" height="32" rx="7" fill="#0f5132" /><path
        d="M10 8h6.5c4.7 0 7.5 3 7.5 8s-2.8 8-7.5 8H10z"
        fill="none"
        stroke="#fff"
        stroke-width="3"
      /></svg
    >
    <div>
      <strong>Deus</strong>
      <span class="muted">Pembukuan dan laporan keuangan otomatis</span>
    </div>
  </div>
  <div class="card">{@render children()}</div>
</main>

<style>
  main {
    min-height: 100vh;
    display: grid;
    place-content: center;
    gap: 1.25rem;
    padding: 1rem;
  }
  .brand {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }
  .brand div {
    display: grid;
  }
  .card {
    width: min(420px, calc(100vw - 2rem));
  }
</style>
