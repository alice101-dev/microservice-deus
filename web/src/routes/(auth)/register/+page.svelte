<script lang="ts">
  import { authClient } from "#lib/auth.ts";
  import Alert from "#lib/components/Alert.svelte";
  import { session } from "#lib/session.svelte.ts";
  import { goto } from "$app/navigation";

  let name = $state("");
  let email = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = null;
    const result = await authClient.signUp.email({ name, email, password });
    busy = false;
    if (result.error) {
      error =
        result.error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
          ? "Email sudah terdaftar"
          : (result.error.message ?? "Gagal mendaftar");
      return;
    }
    await session.load();
    await goto("/onboarding");
  }
</script>

<form class="stack" onsubmit={submit}>
  <h1>Daftar</h1>
  <Alert {error} />
  <label>Nama <input autocomplete="name" required bind:value={name} /></label>
  <label>Email <input type="email" autocomplete="email" required bind:value={email} /></label>
  <label
    >Kata sandi <input type="password" autocomplete="new-password" required minlength="12" bind:value={password} />
    <small class="muted">Minimal 12 karakter</small></label
  >
  <button type="submit" class="primary" disabled={busy}>{busy ? "Memproses…" : "Buat akun"}</button>
  <p class="muted">Sudah punya akun? <a href="/login">Masuk</a></p>
</form>
