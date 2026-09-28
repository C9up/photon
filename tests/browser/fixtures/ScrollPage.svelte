<script>
import { InfiniteScroll } from "../../../src/client/svelte/index.js";

/** @type {{ users?: { data: number[] } }} */
let { users } = $props();
</script>

<div id="scroller" style="height: 150px; overflow-y: auto">
	<InfiniteScroll data="users">
		{#snippet loading()}<p id="loading">loading…</p>{/snippet}
		{#each users?.data ?? [] as row (row)}
			<div style="height: 100px">row {row}</div>
		{/each}
	</InfiniteScroll>
</div>
