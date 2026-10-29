<script lang="ts">
  import "../app.css";
  import { nameEntry, setRoute, startNavigation } from "#lib/interactions.ts";
  import { afterNavigate, beforeNavigate } from "$app/navigation";

  let { children } = $props();

  beforeNavigate((navigation) => {
    if (navigation.willUnload) return;
    startNavigation(navigation.type, navigation.from?.route.id ?? null, navigation.to?.route.id ?? null);
  });
  afterNavigate((navigation) => {
    setRoute(navigation.to?.route.id ?? null);
    if (navigation.type === "enter") nameEntry(navigation.to?.route.id ?? null);
  });
</script>

{@render children()}
