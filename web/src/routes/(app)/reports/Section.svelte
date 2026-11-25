<script lang="ts">
  import { rupiah } from "#lib/format.ts";

  interface Group {
    code: string;
    name: string;
    total: string;
    lines: Array<{ accountId: string | null; code: string | null; name: string; amount: string }>;
  }

  let { title, groups, total }: { title: string; groups: Group[]; total: string } = $props();
</script>

<tbody>
  <tr class="section"><td colspan="2">{title}</td></tr>
  {#each groups as group (group.code + group.name)}
    <tr class="group"><td>{group.code} {group.name}</td><td></td></tr>
    {#each group.lines as line (line.accountId ?? line.name)}
      <tr><td class="indent">{line.code ?? ""} {line.name}</td><td class="num">{rupiah(line.amount)}</td></tr>
    {/each}
  {:else}
    <tr><td class="indent muted">Tidak ada saldo</td><td></td></tr>
  {/each}
  <tr class="total"><td>Total {title.toLowerCase()}</td><td class="num">{rupiah(total)}</td></tr>
</tbody>

<style>
  .section td {
    font-weight: 700;
    background: var(--surface-muted);
  }
  .group td {
    font-weight: 600;
  }
  .indent {
    padding-left: 2rem;
  }
  .total td {
    font-weight: 700;
  }
</style>
