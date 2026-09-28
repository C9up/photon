/// <reference lib="dom" />
// This file uses browser globals. The reference pulls the DOM lib in for
// THIS file whatever `lib` the consumer configured, so a Node app
// typechecking against our sources does not trip over `window` —
// `types: "./src/index.ts"` means every consumer reads them.
/**
 * Photon — infinite scroll over a `scroll()` prop.
 *
 * The server sends one page of a list and a cursor beside it (`scrollProps`);
 * this is the client half that loads the pages around it. A port of
 * `@inertiajs/core` 3.7.1 (`src/infiniteScroll*.ts`, read from its source),
 * part for part and under the same names:
 *
 * - `useInfiniteScrollData` — the cursor, and the partial reload for the next
 *   or previous page: only the scroll prop, `?<pageName>=<page>`, and
 *   `x-photon-infinite-scroll-merge-intent` saying whether the rows go after
 *   (`append`) or before (`prepend`) the ones shown. The server labels the
 *   data array accordingly and the router merges it; the address bar stays.
 * - the element manager — triggers before and after the list observed in the
 *   viewport, and each row tagged with the page it came from;
 * - the query string — the URL follows the page most visible on screen;
 * - scroll preservation — rows inserted above do not push the reader down;
 * - `useInfiniteScroll` — the four wired together, what a framework's
 *   `<InfiniteScroll>` component is built on.
 *
 * One difference: `fetchNext` / `fetchPrevious` return a promise that settles
 * once the page is merged, where Inertia's return nothing.
 *
 * Browser-only — strict no `node:` imports.
 */

import type { PhotonPageData, ScrollPropMeta } from "./hydrate.js";
import {
	getCurrentPage,
	type PartialRequest,
	reloadCurrentPage,
	router,
} from "./router.js";

const MERGE_INTENT_HEADER = "x-photon-infinite-scroll-merge-intent";

/** A page of a scroll prop: a number, a cursor, or null past either end. */
export type InfiniteScrollPageIdentifier = number | string | null;

export interface InfiniteScrollOnCompleteDetails {
	page: InfiniteScrollPageIdentifier;
	completed: boolean;
}

// ─── Data ────────────────────────────────────────────────────────────────

export interface InfiniteScrollDataOptions {
	/** The scroll prop, as the page receives it. */
	getPropName(): string;
	onBeforePreviousRequest?(): void;
	onBeforeNextRequest?(): void;
	/** The answer is in and about to replace what is on screen. */
	onBeforeUpdate?(): void;
	onCompletePreviousRequest?(
		page: InfiniteScrollPageIdentifier,
		details: InfiniteScrollOnCompleteDetails,
	): void;
	onCompleteNextRequest?(
		page: InfiniteScrollPageIdentifier,
		details: InfiniteScrollOnCompleteDetails,
	): void;
	/** Called when the server says the list started over. */
	onReset?(): void;
}

export interface InfiniteScrollData {
	/** The last page loaded, on either side. */
	getLastLoadedPage(): InfiniteScrollPageIdentifier;
	/** The query parameter pages are asked for with. */
	getPageName(): string;
	/** How many pages were loaded since the list (re)started. */
	getRequestCount(): number;
	hasPrevious(): boolean;
	hasNext(): boolean;
	/** Load the page after the last one, if there is one and none is loading. */
	fetchNext(reloadOptions?: PartialRequest): Promise<void>;
	/** Load the page before the first one, if there is one and none is loading. */
	fetchPrevious(reloadOptions?: PartialRequest): Promise<void>;
	/** Stop listening to the router. */
	removeEventListener(): void;
}

type Side = "next" | "previous";

interface ScrollState {
	component: string;
	loading: boolean;
	previousPage: InfiniteScrollPageIdentifier;
	nextPage: InfiniteScrollPageIdentifier;
	lastLoadedPage: InfiniteScrollPageIdentifier;
	requestCount: number;
}

export function useInfiniteScrollData(
	options: InfiniteScrollDataOptions,
): InfiniteScrollData {
	const scrollProp = (): ScrollPropMeta => {
		const meta = getCurrentPage()?.scrollProps?.[options.getPropName()];
		if (meta !== undefined) return meta;
		throw new Error(
			`The page object does not contain a scroll prop named "${options.getPropName()}".`,
		);
	};

	const state: ScrollState = {
		component: "",
		loading: false,
		previousPage: null,
		nextPage: null,
		lastLoadedPage: null,
		requestCount: 0,
	};

	const resetState = (): void => {
		const meta = scrollProp();
		state.component = getCurrentPage()?.component ?? "";
		state.loading = false;
		state.previousPage = meta.previousPage;
		state.nextPage = meta.nextPage;
		state.lastLoadedPage = meta.currentPage;
		state.requestCount = 0;
	};

	const rememberKey = `photon:infinite-scroll-data:${options.getPropName()}`;
	resetState();
	// Back to a list already scrolled through — by the back button or a reload
	// of the tab — resumes where it was, while it is the same first page.
	const remembered = router.restore(rememberKey);
	if (
		isRememberedCursor(remembered) &&
		remembered.lastLoadedPage === scrollProp().currentPage
	) {
		state.previousPage = remembered.previousPage;
		state.nextPage = remembered.nextPage;
		state.lastLoadedPage = remembered.lastLoadedPage;
		state.requestCount = remembered.requestCount;
	}

	const removeEventListener = router.on("success", (event) => {
		if (state.component === event.detail.page.component && scrollProp().reset) {
			resetState();
			options.onReset?.();
		}
	});

	const syncStateOnSuccess = (side: Side): void => {
		const meta = scrollProp();
		state.lastLoadedPage = meta.currentPage;
		if (side === "next") state.nextPage = meta.nextPage;
		else state.previousPage = meta.previousPage;
		state.requestCount += 1;
		router.remember(
			{
				previousPage: state.previousPage,
				nextPage: state.nextPage,
				lastLoadedPage: state.lastLoadedPage,
				requestCount: state.requestCount,
			},
			rememberKey,
		);
	};

	const fetchPage = async (
		side: Side,
		reloadOptions: PartialRequest = {},
	): Promise<void> => {
		const page = side === "next" ? state.nextPage : state.previousPage;
		if (state.loading || page === null) return;
		state.loading = true;
		await reloadCurrentPage({
			preserveErrors: true,
			...reloadOptions,
			data: { ...reloadOptions.data, [scrollProp().pageName]: page },
			only: [...(reloadOptions.only ?? []), options.getPropName()],
			preserveUrl: true,
			headers: {
				[MERGE_INTENT_HEADER]: side === "previous" ? "prepend" : "append",
				...reloadOptions.headers,
			},
			onBefore: (visit) => {
				if (side === "next") options.onBeforeNextRequest?.();
				else options.onBeforePreviousRequest?.();
				return reloadOptions.onBefore?.(visit);
			},
			onBeforeUpdate: (next) => {
				options.onBeforeUpdate?.();
				reloadOptions.onBeforeUpdate?.(next);
			},
			onSuccess: (next) => {
				syncStateOnSuccess(side);
				reloadOptions.onSuccess?.(next);
			},
			onFinish: (visit) => {
				state.loading = false;
				const loaded = visit.completed ? state.lastLoadedPage : null;
				const details = { page: loaded, completed: visit.completed };
				if (side === "next") options.onCompleteNextRequest?.(loaded, details);
				else options.onCompletePreviousRequest?.(loaded, details);
				reloadOptions.onFinish?.(visit);
			},
		});
	};

	return {
		getLastLoadedPage: () => state.lastLoadedPage,
		getPageName: () => scrollProp().pageName,
		getRequestCount: () => state.requestCount,
		hasPrevious: () => state.previousPage !== null,
		hasNext: () => state.nextPage !== null,
		fetchNext: (reloadOptions) => fetchPage("next", reloadOptions),
		fetchPrevious: (reloadOptions) => fetchPage("previous", reloadOptions),
		removeEventListener,
	};
}

interface RememberedCursor {
	previousPage: InfiniteScrollPageIdentifier;
	nextPage: InfiniteScrollPageIdentifier;
	lastLoadedPage: InfiniteScrollPageIdentifier;
	requestCount: number;
}

function isPageIdentifier(
	value: unknown,
): value is InfiniteScrollPageIdentifier {
	return (
		value === null || typeof value === "number" || typeof value === "string"
	);
}

function isRememberedCursor(value: unknown): value is RememberedCursor {
	if (typeof value !== "object" || value === null) return false;
	return (
		isPageIdentifier(Reflect.get(value, "previousPage")) &&
		isPageIdentifier(Reflect.get(value, "nextPage")) &&
		isPageIdentifier(Reflect.get(value, "lastLoadedPage")) &&
		typeof Reflect.get(value, "requestCount") === "number"
	);
}

// ─── DOM helpers (`src/domUtils.ts`) ─────────────────────────────────────

/** A debounced `fn`, with `cancel()` for a call still waiting. */
function debounce<A extends unknown[]>(
	fn: (...args: A) => void,
	delay: number,
): ((...args: A) => void) & { cancel(): void } {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const debounced = (...args: A): void => {
		clearTimeout(timeout);
		timeout = setTimeout(() => fn(...args), delay);
	};
	return Object.assign(debounced, {
		cancel: () => clearTimeout(timeout),
	});
}

/** Call `callback` after `times` animation frames. */
function afterFrames(callback: () => void, times = 1): void {
	window.requestAnimationFrame(() => {
		if (times > 1) afterFrames(callback, times - 1);
		else callback();
	});
}

function elementInViewport(element: HTMLElement): boolean {
	if (element.offsetParent === null) return false;
	const rect = element.getBoundingClientRect();
	const vertically = rect.top < window.innerHeight && rect.bottom >= 0;
	const horizontally = rect.left < window.innerWidth && rect.right >= 0;
	return vertically && horizontally;
}

/**
 * The elements of `elements` in the viewport. From a reference element, only
 * the unbroken run of visible ones around it.
 */
function getElementsInViewportFromCollection(
	elements: HTMLElement[],
	referenceElement?: HTMLElement,
): HTMLElement[] {
	if (referenceElement === undefined) return elements.filter(elementInViewport);
	const referenceIndex = elements.indexOf(referenceElement);
	const upward: HTMLElement[] = [];
	for (let i = referenceIndex; i >= 0; i--) {
		const element = elements[i];
		if (element === undefined || !elementInViewport(element)) break;
		upward.push(element);
	}
	const downward: HTMLElement[] = [];
	for (let i = referenceIndex + 1; i < elements.length; i++) {
		const element = elements[i];
		if (element === undefined || !elementInViewport(element)) break;
		downward.push(element);
	}
	return [...upward.reverse(), ...downward];
}

/**
 * The nearest ancestor of `element` that scrolls, or null for the window —
 * `getScrollableParent` in `@inertiajs/core`, rule for rule.
 */
export function getScrollableParent(
	element: HTMLElement | null,
): HTMLElement | null {
	const hasDimensionConstraint = (
		computedMax: string,
		inline: string,
	): boolean =>
		(computedMax !== "" && computedMax !== "none" && computedMax !== "0px") ||
		(inline !== "" && inline !== "auto" && inline !== "0");
	const isConstrainedByLayout = (
		el: HTMLElement,
		dimension: "height" | "width",
	): boolean => {
		const parent = el.parentElement;
		if (!parent) return false;
		const style = window.getComputedStyle(parent);
		if (style.display === "flex" || style.display === "inline-flex") {
			const column =
				style.flexDirection === "column" ||
				style.flexDirection === "column-reverse";
			return dimension === "height" ? column : !column;
		}
		return style.display === "grid" || style.display === "inline-grid";
	};
	const allowsVerticalScroll = (el: HTMLElement): boolean => {
		const style = window.getComputedStyle(el);
		if (style.overflowY === "scroll") return true;
		if (style.overflowY !== "auto") return false;
		if (style.overflowX === "visible" || style.overflowX === "clip")
			return true;
		return (
			hasDimensionConstraint(style.maxHeight, el.style.height) ||
			isConstrainedByLayout(el, "height")
		);
	};
	const allowsHorizontalScroll = (el: HTMLElement): boolean => {
		const style = window.getComputedStyle(el);
		if (style.overflowX === "scroll") return true;
		if (style.overflowX !== "auto") return false;
		if (style.overflowY === "visible" || style.overflowY === "clip")
			return true;
		return (
			hasDimensionConstraint(style.maxWidth, el.style.width) ||
			isConstrainedByLayout(el, "width")
		);
	};
	let parent = element?.parentElement ?? null;
	while (parent) {
		const scrolls =
			allowsVerticalScroll(parent) || allowsHorizontalScroll(parent);
		if (window.getComputedStyle(parent).display !== "contents" && scrolls) {
			return parent;
		}
		parent = parent.parentElement;
	}
	return null;
}

// ─── Elements ────────────────────────────────────────────────────────────

const PAGE_KEY = "infiniteScrollPage";
const IGNORE_KEY = "infiniteScrollIgnore";

function getPageFromElement(element: HTMLElement): string | undefined {
	return element.dataset[PAGE_KEY];
}

function isHTMLElement(node: Node): node is HTMLElement {
	return node instanceof HTMLElement;
}

interface ElementManagerOptions {
	getPropName(): string;
	getTriggerMargin(): number;
	getStartElement(): HTMLElement | null;
	getEndElement(): HTMLElement | null;
	getItemsElement(): HTMLElement | null;
	getScrollableParent(): HTMLElement | null;
	shouldFetchNext(): boolean;
	shouldFetchPrevious(): boolean;
	onItemIntersected(item: HTMLElement): void;
	onPreviousTriggered(): void;
	onNextTriggered(): void;
}

export interface InfiniteScrollElementManager {
	setupObservers(): void;
	enableTriggers(): void;
	disableTriggers(): void;
	refreshTriggers(): void;
	flushAll(): void;
	processManuallyAddedElements(): void;
	processServerLoadedElements(loadedPage: InfiniteScrollPageIdentifier): void;
}

function useInfiniteScrollElementManager(
	options: ElementManagerOptions,
): InfiniteScrollElementManager {
	const observers: IntersectionObserver[] = [];
	const newObserver = (
		callback: (entry: IntersectionObserverEntry) => void,
		init: IntersectionObserverInit = {},
	): IntersectionObserver => {
		const observer = new IntersectionObserver((entries) => {
			for (const entry of entries) if (entry.isIntersecting) callback(entry);
		}, init);
		observers.push(observer);
		return observer;
	};

	let itemsObserver: IntersectionObserver | undefined;
	let startObserver: IntersectionObserver | undefined;
	let endObserver: IntersectionObserver | undefined;
	let mutationObserver: MutationObserver | undefined;
	let triggersEnabled = false;
	const addedElements = new Set<HTMLElement>();

	const elementIsUntagged = (element: HTMLElement): boolean =>
		!(PAGE_KEY in element.dataset) && !(IGNORE_KEY in element.dataset);

	const rememberKey = (): string =>
		`photon:infinite-scroll-elements:${options.getPropName()}`;

	/** Which rows came with which page, as index ranges — kept in history. */
	const rememberElements = (): void => {
		const ranges: Record<string, { from: number; to: number }> = {};
		const items = options.getItemsElement();
		if (!items) return;
		const children = items.childNodes;
		for (let index = 0; index < children.length; index++) {
			const node = children[index];
			if (node === undefined || !isHTMLElement(node)) continue;
			const page = getPageFromElement(node);
			if (page === undefined) continue;
			const range = ranges[page];
			if (range === undefined) ranges[page] = { from: index, to: index };
			else range.to = index;
		}
		router.remember(ranges, rememberKey());
	};
	const rememberElementsDebounced = debounce(rememberElements, 250);

	const restoreElements = (): boolean => {
		const ranges = router.restore(rememberKey());
		if (typeof ranges !== "object" || ranges === null) return false;
		const items = options.getItemsElement();
		if (!items) return false;
		const children = items.childNodes;
		for (let index = 0; index < children.length; index++) {
			const node = children[index];
			if (node === undefined || !isHTMLElement(node)) continue;
			let page: string | undefined;
			for (const [candidate, range] of Object.entries(ranges)) {
				if (
					typeof range === "object" &&
					range !== null &&
					index >= Number(Reflect.get(range, "from")) &&
					index <= Number(Reflect.get(range, "to"))
				) {
					page = candidate;
					break;
				}
			}
			if (page !== undefined) node.dataset[PAGE_KEY] = page;
			else if (!elementIsUntagged(node)) continue;
			else node.dataset[IGNORE_KEY] = "true";
			itemsObserver?.observe(node);
		}
		return true;
	};

	const setupObservers = (): void => {
		mutationObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of mutation.addedNodes) {
					if (isHTMLElement(node)) addedElements.add(node);
				}
			}
			rememberElementsDebounced();
		});
		const items = options.getItemsElement();
		if (items) mutationObserver.observe(items, { childList: true });
		itemsObserver = newObserver((entry) => {
			if (entry.target instanceof HTMLElement) {
				options.onItemIntersected(entry.target);
			}
		});
		const init: IntersectionObserverInit = {
			root: options.getScrollableParent(),
			rootMargin: `${Math.max(1, options.getTriggerMargin())}px`,
		};
		startObserver = newObserver(() => options.onPreviousTriggered(), init);
		endObserver = newObserver(() => options.onNextTriggered(), init);
	};

	const disableTriggers = (): void => {
		if (!triggersEnabled) return;
		startObserver?.disconnect();
		endObserver?.disconnect();
		triggersEnabled = false;
	};

	const enableTriggers = (): void => {
		if (triggersEnabled) disableTriggers();
		const start = options.getStartElement();
		const end = options.getEndElement();
		if (start && options.shouldFetchPrevious()) startObserver?.observe(start);
		if (end && options.shouldFetchNext()) endObserver?.observe(end);
		triggersEnabled = true;
	};

	let hasRestoredElements = false;

	return {
		setupObservers,
		enableTriggers,
		disableTriggers,
		refreshTriggers: () => {
			if (triggersEnabled) enableTriggers();
		},
		flushAll: () => {
			// A remember still waiting would read a list that is gone.
			rememberElementsDebounced.cancel();
			disableTriggers();
			for (const observer of observers) observer.disconnect();
			observers.length = 0;
			mutationObserver?.disconnect();
		},
		/** Rows the page added itself are not the server's: they carry no page. */
		processManuallyAddedElements: () => {
			for (const element of addedElements) {
				if (elementIsUntagged(element)) element.dataset[IGNORE_KEY] = "true";
				itemsObserver?.observe(element);
			}
			addedElements.clear();
		},
		processServerLoadedElements: (loadedPage) => {
			if (!hasRestoredElements) {
				hasRestoredElements = true;
				if (restoreElements()) return;
			}
			const container = options.getItemsElement();
			if (!container) return;
			const untagged = container.querySelectorAll<HTMLElement>(
				":scope > *:not([data-infinite-scroll-page]):not([data-infinite-scroll-ignore])",
			);
			for (const element of untagged) {
				if (elementIsUntagged(element)) {
					element.dataset[PAGE_KEY] =
						loadedPage === null ? "1" : String(loadedPage);
				}
				itemsObserver?.observe(element);
			}
			rememberElements();
		},
	};
}

// ─── Query string ────────────────────────────────────────────────────────

interface QueryStringOptions {
	getPageName(): string;
	getItemsElement(): HTMLElement | null;
	shouldPreserveUrl(): boolean;
}

/**
 * The URL follows the page whose rows fill most of the screen, so a reload or
 * a shared link lands where the reader was. Page 1 is the bare URL.
 */
function useInfiniteScrollQueryString(options: QueryStringOptions): {
	onItemIntersected(item: HTMLElement): void;
	cancel(): void;
} {
	let enabled = true;

	const updateUrl = (page: string): void => {
		const current = getCurrentPage();
		if (!enabled || current === undefined) return;
		const url = new URL(current.url, window.location.href);
		if (page === "1") url.searchParams.delete(options.getPageName());
		else url.searchParams.set(options.getPageName(), page);
		const next = url.pathname + url.search + url.hash;
		if (next !== current.url) router.replace({ url: next });
	};

	const onItemIntersected = debounce((item: HTMLElement) => {
		const container = options.getItemsElement();
		if (!enabled || !container || options.shouldPreserveUrl()) return;
		const counts = new Map<string, number>();
		const children = Array.from(container.children).filter(
			(child): child is HTMLElement => child instanceof HTMLElement,
		);
		for (const element of getElementsInViewportFromCollection(children, item)) {
			const page = getPageFromElement(element) ?? "1";
			counts.set(page, (counts.get(page) ?? 0) + 1);
		}
		const mostVisible = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
		if (mostVisible !== undefined) updateUrl(mostVisible[0]);
	}, 250);

	return {
		onItemIntersected,
		cancel: () => {
			enabled = false;
			onItemIntersected.cancel();
		},
	};
}

// ─── Scroll preservation ────────────────────────────────────────────────

interface PreservationOptions {
	getScrollableParent(): HTMLElement | null;
	getItemsElement(): HTMLElement | null;
}

/**
 * Rows inserted above the reader push everything down; this puts the row the
 * reader was looking at back where it was on screen.
 */
function useInfiniteScrollPreservation(options: PreservationOptions): {
	createCallbacks(): {
		captureScrollPosition(): void;
		restoreScrollPosition(): void;
	};
} {
	return {
		createCallbacks() {
			let scrollTop = 0;
			let reference: HTMLElement | null = null;
			let referenceTop = 0;
			const containerTop = (container: HTMLElement | null): number =>
				container ? container.getBoundingClientRect().top : 0;
			return {
				captureScrollPosition() {
					const container = options.getScrollableParent();
					scrollTop = container?.scrollTop || window.scrollY;
					const children = Array.from(
						options.getItemsElement()?.children ?? [],
					).filter(
						(child): child is HTMLElement => child instanceof HTMLElement,
					);
					const visible = getElementsInViewportFromCollection(children);
					reference = visible[0] ?? null;
					if (reference) {
						referenceTop =
							reference.getBoundingClientRect().top - containerTop(container);
					}
				},
				restoreScrollPosition() {
					const element = reference;
					if (!element) return;
					let attempts = 0;
					let restored = false;
					const restore = (): void => {
						attempts++;
						if (restored || attempts > 10) return;
						const container = options.getScrollableParent();
						const top =
							element.getBoundingClientRect().top - containerTop(container);
						const adjustment = top - referenceTop;
						if (adjustment === 0) {
							window.requestAnimationFrame(restore);
							return;
						}
						if (container) container.scrollTo({ top: scrollTop + adjustment });
						else window.scrollTo(0, window.scrollY + adjustment);
						restored = true;
					};
					window.requestAnimationFrame(restore);
				},
			};
		},
	};
}

// ─── Orchestration ───────────────────────────────────────────────────────

export interface UseInfiniteScrollOptions {
	getPropName(): string;
	/** Newest at the bottom, loading older rows upward (a chat). */
	inReverseMode(): boolean;
	shouldFetchNext(): boolean;
	shouldFetchPrevious(): boolean;
	/** Keep the URL as it is instead of following the visible page. */
	shouldPreserveUrl(): boolean;
	getReloadOptions?(): PartialRequest;
	/** How far from the viewport a trigger starts a load, in pixels. */
	getTriggerMargin(): number;
	getStartElement(): HTMLElement | null;
	getEndElement(): HTMLElement | null;
	/** The element whose children are the rows. */
	getItemsElement(): HTMLElement | null;
	getScrollableParent(): HTMLElement | null;
	onBeforePreviousRequest(): void;
	onBeforeNextRequest(): void;
	onCompletePreviousRequest(details: InfiniteScrollOnCompleteDetails): void;
	onCompleteNextRequest(details: InfiniteScrollOnCompleteDetails): void;
	onDataReset?(): void;
}

export interface UseInfiniteScrollProps {
	dataManager: InfiniteScrollData;
	elementManager: InfiniteScrollElementManager;
	/** Stop everything: observers, listeners, pending URL updates. */
	flush(): void;
}

export function useInfiniteScroll(
	options: UseInfiniteScrollOptions,
): UseInfiniteScrollProps {
	const scrollPreservation = useInfiniteScrollPreservation(options);
	// The element manager needs the data manager's fetches and the data manager
	// needs the element manager's hooks; both are built before either is
	// called, as in upstream.
	let dataManager: InfiniteScrollData | undefined;
	const queryString = useInfiniteScrollQueryString({
		...options,
		getPageName: () => dataManager?.getPageName() ?? "page",
	});
	const elementManager = useInfiniteScrollElementManager({
		...options,
		onItemIntersected: queryString.onItemIntersected,
		onPreviousTriggered: () => {
			void dataManager?.fetchPrevious();
		},
		onNextTriggered: () => {
			void dataManager?.fetchNext();
		},
	});
	const data = useInfiniteScrollData({
		...options,
		// Rows the page added itself are tagged before the server's arrive.
		onBeforeUpdate: elementManager.processManuallyAddedElements,
		onCompletePreviousRequest: (_page, details) => {
			options.onCompletePreviousRequest(details);
			if (details.completed) {
				afterFrames(
					() => elementManager.processServerLoadedElements(details.page),
					2,
				);
			}
		},
		onCompleteNextRequest: (_page, details) => {
			options.onCompleteNextRequest(details);
			if (details.completed) {
				afterFrames(
					() => elementManager.processServerLoadedElements(details.page),
					2,
				);
			}
		},
		onReset: options.onDataReset,
	});

	/** Keep the reader's place when rows arrive on the side above them. */
	const withPreservation = (reloadOptions: PartialRequest): PartialRequest => {
		const { captureScrollPosition, restoreScrollPosition } =
			scrollPreservation.createCallbacks();
		return {
			...reloadOptions,
			onBeforeUpdate: (page: PhotonPageData) => {
				reloadOptions.onBeforeUpdate?.(page);
				captureScrollPosition();
			},
			onSuccess: (page: PhotonPageData) => {
				reloadOptions.onSuccess?.(page);
				restoreScrollPosition();
			},
		};
	};

	dataManager = {
		...data,
		fetchNext: (reloadOptions = {}) => {
			let merged = { ...options.getReloadOptions?.(), ...reloadOptions };
			if (options.inReverseMode()) merged = withPreservation(merged);
			return data.fetchNext(merged);
		},
		fetchPrevious: (reloadOptions = {}) => {
			let merged = { ...options.getReloadOptions?.(), ...reloadOptions };
			if (!options.inReverseMode()) merged = withPreservation(merged);
			return data.fetchPrevious(merged);
		},
	};

	const removeEventListener = router.on("success", () =>
		afterFrames(elementManager.refreshTriggers, 2),
	);

	return {
		dataManager,
		elementManager,
		flush: () => {
			removeEventListener();
			data.removeEventListener();
			elementManager.flushAll();
			queryString.cancel();
		},
	};
}
