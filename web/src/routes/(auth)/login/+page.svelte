<script lang="ts">
  import { authClient } from "#lib/auth.ts";
  import Alert from "#lib/components/Alert.svelte";
  import { session } from "#lib/session.svelte.ts";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  let email = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = null;
    const result = await authClient.signIn.email({ email, password });
    busy = false;
    if (result.error) {
      error = result.error.status === 401 ? "Email atau kata sandi salah" : (result.error.message ?? "Gagal masuk");
      return;
    }
    await session.load();
    const next = page.url.searchParams.get("next");
    await goto(session.activeOrganizationId ? (next?.startsWith("/") ? next : "/") : "/onboarding");
  }
</script>

<form class="stack" onsubmit={submit}>
  <h1>Masuk</h1>
  <Alert {error} />
  <label>Email <input type="email" autocomplete="email" required bind:value={email} /></label>
  <label
    >Kata sandi <input type="password" autocomplete="current-password" required minlength="12" bind:value={password}
    /></label
  >
  <button type="submit" class="primary" disabled={busy}>{busy ? "Memproses…" : "Masuk"}</button>
  <p class="muted">Belum punya akun? <a href="/register">Daftar</a></p>
</form>
