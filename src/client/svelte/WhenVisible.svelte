<!--
  Load `data` when this scrolls into view; the `fallback` snippet until it has —
  `WhenVisible` from `@inertiajs/svelte` 3.7.1, on Photon's router.
-->
<script lang="ts">
import type { Snippet } from "svelte";
import { type PartialRequest, router } from "../router.js";
import { usePage } from "./page.svelte.js";

interface Props {
	data?: string | string[];
	params?: PartialRequest;
	buffer?: number;
	as?: keyof HTMLElementTagNameMap;
	always?: boolean;
	children?: Snippet<[{ fetching: boolean }]>;
	fallback?: Snippet;
}

let {
	data = "",
	params = {},
	buffer = 0,
	as = "div",
	always = false,
	children,
	fallback,
}: Props = $props();

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
const keys = $derived(data ? (Array.isArray(data) ? data : [data]) : []);
let loaded = $derived(
	keys.length > 0 && keys.every((key) => propAt(page.props, key) !== undefined),
);
let fetching = $state(false);
let observer: IntersectionObserver | null = null;

function reloadParams(): PartialRequest {
	return {
		preserveErrors: true,
		...params,
		...(data !== "" ? { only: Array.isArray(data) ? data : [data] } : {}),
	};
}

function attachObserver(element: HTMLElement) {
	observer = new IntersectionObserver(
		(entries) => {
			if (!entries[0]?.isIntersecting) return;
			if (fetching || (!always && loaded)) return;
			fetching = true;
			const request = reloadParams();
			void router.reload({
				...request,
				onFinish: (visit) => {
					loaded = true;
					fetching = false;
					request.onFinish?.(visit);
					if (!always) observer?.disconnect();
				},
			});
		},
		{ rootMargin: `${buffer}px` },
	);
	observer.observe(element);
	return () => observer?.disconnect();
}
</script>

{#if always || !loaded}
	<svelte:element this={as} {@attach attachObserver} />
{/if}

{#if loaded}
	{@render children?.({ fetching })}
{:else if fallback}
	{@render fallback()}
{/if}
