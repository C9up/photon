<script>
import { Deferred } from "../../../src/client/svelte/index.js";

/** @type {{ stats?: number }} */
let { stats } = $props();
</script>

<Deferred data="stats">
	{#snippet fallback()}<p>loading</p>{/snippet}
	{#snippet children({ reloading })}<p>stats {stats}{reloading ? " (reloading)" : ""}</p>{/snippet}
</Deferred>
