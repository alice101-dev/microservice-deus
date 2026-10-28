<script lang="ts">
  import { session } from "#lib/session.svelte.ts";
  import { afterNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";

  let { children } = $props();
  let menuOpen = $state(false);
  afterNavigate(() => {
    menuOpen = false;
  });

  const SECTIONS = [
    {
      title: "Ringkasan",
      links: [{ href: "/", label: "Beranda" }],
    },
    {
      title: "Transaksi",
      links: [
        { href: "/sales", label: "Penjualan" },
        { href: "/purchases", label: "Pembelian" },
        { href: "/payments", label: "Pembayaran" },
        { href: "/banking", label: "Bank" },
      ],
    },
    {
      title: "Data",
      links: [
        { href: "/contacts", label: "Kontak" },
        { href: "/products", label: "Produk & jasa" },
        { href: "/accounts", label: "Bagan akun" },
      ],
    },
    {
      title: "Akuntansi",
      links: [
        { href: "/ledger", label: "Jurnal umum" },
        { href: "/reports", label: "Laporan keuangan" },
        { href: "/tax", label: "Pajak (PPN)" },
      ],
    },
    {
      title: "Lainnya",
      links: [
        { href: "/notifications", label: "Email terkirim" },
        { href: "/settings", label: "Pengaturan" },
      ],
    },
  ];

  const active = (href: string) => (href === "/" ? page.url.pathname === "/" : page.url.pathname.startsWith(href));

  async function switchOrganization(event: Event) {
    const id = (event.currentTarget as HTMLSelectElement).value;
    await session.setActive(id);
    await goto("/", { invalidateAll: true });
  }

  async function signOut() {
    await session.signOut();
    await goto("/login");
  }
</script>

<div class="shell" class:open={menuOpen}>
  <aside>
    <div class="brand">
      <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"
        ><rect width="32" height="32" rx="7" fill="#fff" /><path
          d="M10 8h6.5c4.7 0 7.5 3 7.5 8s-2.8 8-7.5 8H10z"
          fill="none"
          stroke="#0f5132"
          stroke-width="3"
        /></svg
      >
      <strong>Deus</strong>
    </div>
    {#if session.organizations.length > 1}
      <select aria-label="Organisasi" value={session.activeOrganizationId} onchange={switchOrganization}>
        {#each session.organizations as organization (organization.id)}
          <option value={organization.id}>{organization.name}</option>
        {/each}
      </select>
    {:else}
      <div class="org">{session.organization?.name}</div>
    {/if}
    <nav>
      {#each SECTIONS as section (section.title)}
        <div class="section">{section.title}</div>
        {#each section.links as link (link.href)}
          <a href={link.href} class:active={active(link.href)}>{link.label}</a>
        {/each}
      {/each}
    </nav>
    <div class="user">
      <span>{session.user?.name}</span>
      <small>{session.user?.email}</small>
      <button type="button" onclick={signOut}>Keluar</button>
    </div>
  </aside>
  <div class="content">
    <button type="button" class="menu" aria-label="Menu" onclick={() => (menuOpen = !menuOpen)}>☰ Menu</button>
    <main>{@render children()}</main>
  </div>
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: 240px 1fr;
    min-height: 100vh;
  }
  aside {
    background: var(--primary);
    color: #e9f3ec;
    padding: 1rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
  }
  .brand {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    font-size: 1.15rem;
    padding: 0 0.4rem;
    color: #fff;
  }
  .org {
    padding: 0.45rem 0.6rem;
    background: rgb(255 255 255 / 10%);
    border-radius: 8px;
    font-weight: 600;
  }
  aside select {
    background: rgb(255 255 255 / 10%);
    color: #fff;
    border-color: rgb(255 255 255 / 25%);
  }
  aside select option {
    color: var(--text);
  }
  nav {
    display: grid;
    gap: 0.1rem;
    flex: 1;
  }
  .section {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.65;
    margin: 0.7rem 0.6rem 0.2rem;
  }
  nav a {
    color: #e9f3ec;
    text-decoration: none;
    padding: 0.45rem 0.6rem;
    border-radius: 7px;
  }
  nav a:hover {
    background: rgb(255 255 255 / 8%);
  }
  nav a.active {
    background: #fff;
    color: var(--primary);
    font-weight: 600;
  }
  .user {
    display: grid;
    gap: 0.2rem;
    padding: 0.6rem;
    border-top: 1px solid rgb(255 255 255 / 15%);
  }
  .user small {
    opacity: 0.75;
    overflow-wrap: anywhere;
  }
  .user button {
    margin-top: 0.4rem;
    background: transparent;
    color: #fff;
    border-color: rgb(255 255 255 / 30%);
    justify-content: center;
  }
  .content {
    min-width: 0;
  }
  main {
    padding: 1.75rem 2rem 3rem;
    max-width: 1200px;
    display: grid;
    gap: 1.25rem;
  }
  .menu {
    display: none;
  }
  @media (max-width: 900px) {
    .shell {
      grid-template-columns: 1fr;
    }
    aside {
      display: none;
      position: fixed;
      inset: 0 auto 0 0;
      width: 260px;
      z-index: 10;
    }
    .open aside {
      display: flex;
    }
    .menu {
      display: inline-flex;
      margin: 1rem 1rem 0;
    }
    main {
      padding: 1rem;
    }
  }
</style>
