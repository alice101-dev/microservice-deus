<script lang="ts">
  import { page } from "$app/state";
</script>

<main>
  <div class="card stack">
    <h1>{page.status === 404 ? "Tidak ditemukan" : "Terjadi kesalahan"}</h1>
    <p class="muted">{page.error?.message}</p>
    {#if page.error?.traceId}<small class="muted">Kode jejak: {page.error.traceId}</small>{/if}
    <a class="button" href="/">Kembali ke beranda</a>
  </div>
</main>

<style>
  main {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 1rem;
  }
  .card {
    max-width: 440px;
  }
</style>
