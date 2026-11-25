<script lang="ts">
  import "../app.css";
  import { setPage } from "#lib/telemetry.ts";
  import { afterNavigate, beforeNavigate } from "$app/navigation";
  import { updated } from "$app/state";

  let { children } = $props();

  beforeNavigate(({ willUnload, to }) => {
    if (updated.current && !willUnload && to?.url) location.href = to.url.href;
    else if (!willUnload && to?.url) setPage(to.url);
  });
  afterNavigate(({ to }) => {
    if (to?.url) setPage(to.url);
  });
</script>

{@render children()}
