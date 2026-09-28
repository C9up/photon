<!--
  Its children once every prop in `data` is on the page, the `fallback` snippet
  until then, and `rescue` when the server rescued one of them — `Deferred`
  from `@inertiajs/svelte` 3.7.1, on Photon's router.
-->
<script lang="ts">
import type { Snippet } from "svelte";
import { partialReloadRequestsProp, router, type Visit } from "../router.js";
import { usePage } from "./page.svelte.js";

interface Props {
	data: string | string[];
	rescue?: Snippet<[{ reloading: boolean }]>;
	fallback?: Snippet;
	children?: Snippet<[{ reloading: boolean }]>;
}

let { data, rescue, fallback, children }: Props = $props();

const page = usePage();
const propAt = (props: Record<string, unknown>, path: string): unknown =>
	path
		.split(".")
		.reduce<unknown>(
			(value, segment) =>
				typeof value === "object" && value !== null
					? Reflect.get(value, segment)
					: undefined,
			props,
		);
const keys = $derived(Array.isArray(data) ? data : [data]);
const rescuedKeys = $derived(new Set(page.rescuedProps ?? []));
const loaded = $derived(
	keys.every((key) => propAt(page.props, key) !== undefined),
);
const failed = $derived(keys.some((key) => rescuedKeys.has(key)));

let reloading = $state(false);
const activeReloads = new Set<Visit>();

$effect(() => {
	const offStart = router.on("start", (event) => {
		const { visit } = event.detail;
		const url = new URL(visit.url, window.location.href);
		if (
			visit.preserveState &&
			url.origin === window.location.origin &&
			url.pathname === window.location.pathname &&
			keys.some((key) => partialReloadRequestsProp(visit, key))
		) {
			activeReloads.add(visit);
			reloading = true;
		}
	});
	const offFinish = router.on("finish", (event) => {
		if (activeReloads.delete(event.detail.visit)) {
			reloading = activeReloads.size > 0;
		}
	});
	return () => {
		offStart();
		offFinish();
		activeReloads.clear();
	};
});

$effect.pre(() => {
	if (!fallback) throw new Error("`<Deferred>` requires a `fallback` snippet");
});
</script>

{#if loaded && !failed}
	{@render children?.({ reloading })}
{:else if failed && rescue}
	{@render rescue({ reloading })}
{:else}
	{@render fallback?.()}
{/if}
