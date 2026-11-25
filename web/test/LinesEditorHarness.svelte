<script lang="ts">
  import LinesEditor from "#lib/components/LinesEditor.svelte";
  import { blankLine, type ProductOption } from "#lib/lines.ts";

  let { products, accounts }: { products: ProductOption[]; accounts: Array<{ id: string; code: string; name: string }> } =
    $props();
  let lines = $state([blankLine()]);
</script>

<LinesEditor bind:lines {products} {accounts} side="sale" />
