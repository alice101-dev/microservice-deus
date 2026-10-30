<script lang="ts">
  import "../app.css";
  import { namePageload, routeName, startPage } from "#lib/pages.ts";
  import { afterNavigate, beforeNavigate } from "$app/navigation";

  let { children } = $props();

  beforeNavigate((navigation) => {
    if (navigation.willUnload || !navigation.to) return;
    startPage("navigation", routeName(navigation.to.route.id), {
      "navigation.type": navigation.type,
      "app.route.from": routeName(navigation.from?.route.id),
    });
  });
  afterNavigate((navigation) => {
    if (navigation.type === "enter") namePageload(navigation.to?.route.id);
  });
</script>

{@render children()}
