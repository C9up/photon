<!--
  A link the router follows without a page load — `Link` from
  `@inertiajs/svelte` 3.7.1, without prefetching (Photon has no visit cache).
  Any method but GET renders a button, as upstream does.
-->
<script lang="ts">
import type { Snippet } from "svelte";
import {
	type Method,
	type RequestPayload,
	router,
	type VisitOptions,
	withQuery,
} from "../router.js";

interface Props {
	href: string;
	as?: keyof HTMLElementTagNameMap;
	method?: Method;
	data?: RequestPayload;
	replace?: boolean;
	preserveState?: boolean;
	preserveUrl?: boolean;
	only?: string[];
	except?: string[];
	headers?: Record<string, string>;
	errorBag?: string;
	onBefore?: VisitOptions["onBefore"];
	onStart?: VisitOptions["onStart"];
	onSuccess?: VisitOptions["onSuccess"];
	onError?: VisitOptions["onError"];
	onFinish?: VisitOptions["onFinish"];
	children?: Snippet;
	[key: string]: unknown;
}

let {
	href,
	as = "a",
	method = "get",
	data = {},
	replace = false,
	preserveState,
	preserveUrl = false,
	only = [],
	except = [],
	headers = {},
	errorBag,
	onBefore,
	onStart,
	onSuccess,
	onError,
	onFinish,
	children,
	...rest
}: Props = $props();

let inFlight = $state(0);
const element = $derived(as === "a" && method !== "get" ? "button" : as);
const url = $derived(method === "get" ? withQuery(href, data) : href);

function intercepts(event: MouseEvent): boolean {
	const target = event.currentTarget;
	const editable =
		event.target instanceof HTMLElement && event.target.isContentEditable;
	if (editable || event.defaultPrevented) return false;
	if (!(target instanceof HTMLAnchorElement)) return true;
	return !(
		event.altKey ||
		event.ctrlKey ||
		event.metaKey ||
		event.shiftKey ||
		(target.target !== "" && target.target !== "_self") ||
		event.button !== 0
	);
}

function onclick(event: MouseEvent) {
	if (!intercepts(event)) return;
	event.preventDefault();
	void router.visit(url, {
		method,
		...(method === "get" ? {} : { data }),
		preserveState: preserveState ?? method !== "get",
		preserveUrl,
		replace,
		only,
		except,
		headers,
		errorBag,
		onBefore,
		onStart: (started) => {
			inFlight++;
			onStart?.(started);
		},
		onSuccess,
		onError,
		onFinish: (finished) => {
			inFlight--;
			onFinish?.(finished);
		},
	});
}
</script>

<svelte:element
	this={element}
	{...rest}
	href={element === "a" ? url : undefined}
	type={element === "button" ? "button" : undefined}
	{onclick}
	data-loading={inFlight > 0 ? "" : undefined}
>
	{@render children?.()}
</svelte:element>
