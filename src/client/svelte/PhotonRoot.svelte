<!--
  Photon's root for Svelte 5: it renders whichever page it holds, and the
  router hands it the next one through `setPage`.

  Svelte 5 has no way, outside a `.svelte` file, to give a mounted component new
  props: they only update through runes. Without this root the adapter had to
  unmount the page and mount it again for every change of props — a deferred
  group or a partial reload reset every component on screen. Here the SAME
  component is updated in place and keeps its state; another one replaces it.

  The shape of `App.svelte` in `@inertiajs/svelte`: a `$state` page, a dynamic
  component. The server renders it too (see the SSR entry in the docs), so the
  markup the client hydrates is the markup this component produces. Given the
  whole `page` there, it also makes it what `usePage()` returns while the page
  renders, as `App.svelte` does.
-->
<script>
import { setPage as setCurrentPage } from "./page.svelte.js";

/** @type {{ component: unknown; props: Record<string, unknown>; page?: Record<string, unknown> }} */
let { component, props, page: fullPage } = $props();

// svelte-ignore state_referenced_locally
if (fullPage !== undefined) setCurrentPage(fullPage);

// svelte-ignore state_referenced_locally
let page = $state({ component, props });

/** @param {{ component: unknown; props: Record<string, unknown> }} next */
export function setPage(next) {
	page = next;
}
</script>

<page.component {...page.props} />
