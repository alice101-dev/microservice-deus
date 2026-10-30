<script lang="ts">
  import "../app.css";
  import { beforeNavigate } from "$app/navigation";
  import { updated } from "$app/state";

  let { children } = $props();

  beforeNavigate(({ willUnload, to }) => {
    if (updated.current && !willUnload && to?.url) location.href = to.url.href;
  });
</script>

{@render children()}
