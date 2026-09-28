<script>
import { WhenVisible } from "../../../src/client/svelte/index.js";

/** @type {{ comments?: string[] }} */
let { comments } = $props();
</script>

<div style="height: 2000px"></div>
<WhenVisible data="comments">
	{#snippet fallback()}<p>waiting</p>{/snippet}
	<p>comments: {JSON.stringify(comments)}</p>
</WhenVisible>
