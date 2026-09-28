<!--
  A list that loads the pages of a scroll prop as the reader reaches them —
  `InfiniteScroll` from `@inertiajs/svelte` 3.7.1, on Photon's
  `useInfiniteScroll`. Same props, same snippets (`previous`, `next`,
  `loading`, children) and the same exported methods.
-->
<script lang="ts">
import { onDestroy, onMount, type Snippet } from "svelte";
import {
	getScrollableParent,
	type UseInfiniteScrollProps,
	useInfiniteScroll,
} from "../infiniteScroll.js";
import type { PartialRequest } from "../router.js";
import { usePage } from "./page.svelte.js";

type ElementReference = string | (() => HTMLElement | null) | null;

interface ActionSlotProps {
	loading: boolean;
	loadingPrevious: boolean;
	loadingNext: boolean;
	fetch: () => void;
	autoMode: boolean;
	manualMode: boolean;
	hasMore: boolean;
	hasPrevious: boolean;
	hasNext: boolean;
}

interface SlotProps {
	loading: boolean;
	loadingPrevious: boolean;
	loadingNext: boolean;
}

interface Props {
	data: string;
	buffer?: number;
	as?: keyof HTMLElementTagNameMap;
	manual?: boolean;
	manualAfter?: number;
	preserveUrl?: boolean;
	reverse?: boolean;
	autoScroll?: boolean;
	startElement?: ElementReference;
	endElement?: ElementReference;
	itemsElement?: ElementReference;
	params?: PartialRequest;
	onlyNext?: boolean;
	onlyPrevious?: boolean;
	previous?: Snippet<[ActionSlotProps]>;
	loading?: Snippet<[ActionSlotProps]>;
	next?: Snippet<[ActionSlotProps]>;
	children?: Snippet<[SlotProps]>;
	[key: string]: unknown;
}

let {
	data,
	buffer = 0,
	as = "div",
	manual = false,
	manualAfter = 0,
	preserveUrl = false,
	reverse = false,
	autoScroll = undefined,
	startElement = null,
	endElement = null,
	itemsElement = null,
	params = {},
	onlyNext = false,
	onlyPrevious = false,
	previous,
	loading,
	next,
	children,
	...rest
}: Props = $props();

let itemsElementRef: HTMLElement | null = $state(null);
let startElementRef: HTMLElement | null = $state(null);
let endElementRef: HTMLElement | null = $state(null);
// svelte-ignore state_referenced_locally
const scrollProp = usePage().scrollProps?.[data];

let loadingPrevious = $state(false);
let loadingNext = $state(false);
let requestCount = $state(0);
let hasPreviousPage = $state(scrollProp?.previousPage != null);
let hasNextPage = $state(scrollProp?.nextPage != null);
let instance: UseInfiniteScrollProps | null = $state(null);

function resolveElement(
	value: ElementReference,
	fallback: HTMLElement | null,
): HTMLElement | null {
	if (!value) return fallback;
	if (typeof value === "string") {
		const found = document.querySelector(value);
		return found instanceof HTMLElement ? found : null;
	}
	return value() ?? null;
}

export function fetchPrevious(options?: PartialRequest) {
	void instance?.dataManager.fetchPrevious(options);
}

export function fetchNext(options?: PartialRequest) {
	void instance?.dataManager.fetchNext(options);
}

export function hasPrevious(): boolean {
	return instance?.dataManager.hasPrevious() ?? false;
}

export function hasNext(): boolean {
	return instance?.dataManager.hasNext() ?? false;
}

function syncState() {
	if (!instance) return;
	requestCount = instance.dataManager.getRequestCount();
	hasPreviousPage = instance.dataManager.hasPrevious();
	hasNextPage = instance.dataManager.hasNext();
}

onMount(() => {
	const items = resolveElement(itemsElement, itemsElementRef);
	const start = resolveElement(startElement, startElementRef);
	const end = resolveElement(endElement, endElementRef);
	const scrollable = items ? getScrollableParent(items) : null;
	const scroll = useInfiniteScroll({
		getPropName: () => data,
		inReverseMode: () => reverse,
		shouldFetchNext: () => !onlyPrevious,
		shouldFetchPrevious: () => !onlyNext,
		shouldPreserveUrl: () => preserveUrl,
		getReloadOptions: () => params,
		getTriggerMargin: () => buffer,
		getStartElement: () => start,
		getEndElement: () => end,
		getItemsElement: () => items,
		getScrollableParent: () => scrollable,
		onBeforePreviousRequest: () => (loadingPrevious = true),
		onBeforeNextRequest: () => (loadingNext = true),
		onCompletePreviousRequest: ({ completed }) => {
			loadingPrevious = false;
			if (completed) syncState();
		},
		onCompleteNextRequest: ({ completed }) => {
			loadingNext = false;
			if (completed) syncState();
		},
		onDataReset: syncState,
	});
	instance = scroll;
	syncState();
	scroll.elementManager.setupObservers();
	scroll.elementManager.processServerLoadedElements(
		scroll.dataManager.getLastLoadedPage(),
	);
	if (autoScroll ?? reverse) {
		if (scrollable)
			scrollable.scrollTo({
				top: scrollable.scrollHeight,
				behavior: "instant",
			});
		else
			window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
	}
});

onDestroy(() => instance?.flush());

const manualMode = $derived(
	manual || (manualAfter > 0 && requestCount >= manualAfter),
);
const autoLoad = $derived(!manualMode);
const shared = $derived({
	loadingPrevious,
	loadingNext,
	hasPrevious: hasPreviousPage,
	hasNext: hasNextPage,
});
const headerAutoMode = $derived(autoLoad && !onlyNext);
const exposedPrevious: ActionSlotProps = $derived({
	loading: loadingPrevious,
	fetch: () => fetchPrevious(),
	autoMode: headerAutoMode,
	manualMode: !headerAutoMode,
	hasMore: hasPreviousPage,
	...shared,
});
const footerAutoMode = $derived(autoLoad && !onlyPrevious);
const exposedNext: ActionSlotProps = $derived({
	loading: loadingNext,
	fetch: () => fetchNext(),
	autoMode: footerAutoMode,
	manualMode: !footerAutoMode,
	hasMore: hasNextPage,
	...shared,
});
const exposedSlot: SlotProps = $derived({
	loading: loadingPrevious || loadingNext,
	loadingPrevious,
	loadingNext,
});

$effect(() => {
	// Re-run whenever a side, the mode or the direction changes.
	void [onlyNext, onlyPrevious, reverse];
	if (autoLoad) instance?.elementManager.enableTriggers();
	else instance?.elementManager.disableTriggers();
});
</script>

{#if !startElement && !reverse}
	<div bind:this={startElementRef}>
		{#if previous}{@render previous(exposedPrevious)}{:else if loadingPrevious}{@render loading?.(exposedPrevious)}{/if}
	</div>
{/if}

{#if !endElement && reverse}
	<div bind:this={endElementRef}>
		{#if next}{@render next(exposedNext)}{:else if loadingNext}{@render loading?.(exposedNext)}{/if}
	</div>
{/if}

<svelte:element this={as} bind:this={itemsElementRef} {...rest}>
	{@render children?.(exposedSlot)}
</svelte:element>

{#if !startElement && reverse}
	<div bind:this={startElementRef}>
		{#if previous}{@render previous(exposedPrevious)}{:else if loadingPrevious}{@render loading?.(exposedPrevious)}{/if}
	</div>
{/if}

{#if !endElement && !reverse}
	<div bind:this={endElementRef}>
		{#if next}{@render next(exposedNext)}{:else if loadingNext}{@render loading?.(exposedNext)}{/if}
	</div>
{/if}
