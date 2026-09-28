/// <reference lib="dom" />
/**
 * Photon's React components — `@c9up/photon/react`.
 *
 * `usePage`, `Deferred`, `WhenVisible` and `InfiniteScroll`, ported from
 * `@inertiajs/react` 3.7.1 (read from its source) onto Photon's router, with
 * the same props and the same behaviour.
 *
 * One structural difference. Inertia's `App` component provides the page to
 * every component, on the server and in the browser. Photon renders the page
 * component itself, so the page comes from two places: the router's store in
 * the browser (primed before hydration, so the first render matches the
 * server's), and `<PhotonPage page={pageData}>` around the page in the SSR
 * entry. An app that never calls `usePage` — directly or through these
 * components — needs neither.
 *
 * Only a React app imports this module, so React's types enter no other app's
 * program.
 */

import {
	createContext,
	createElement,
	type ElementType,
	type FormEvent,
	type FormHTMLAttributes,
	type ForwardedRef,
	Fragment,
	forwardRef,
	type HTMLAttributes,
	type MouseEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createForm, type FormState, type FormStore } from "../form.js";
import {
	createFormController,
	type FormComponentOptions,
	type FormSlotProps,
} from "../formElement.js";
import type { PhotonPageData } from "../hydrate.js";
import {
	useInfiniteScroll as createInfiniteScroll,
	getScrollableParent,
	type InfiniteScrollData,
	type InfiniteScrollElementManager,
	type UseInfiniteScrollProps,
} from "../infiniteScroll.js";
import {
	getCurrentPage,
	type Method,
	type PartialRequest,
	partialReloadRequestsProp,
	type RequestPayload,
	router,
	subscribeToPage,
	type Visit,
	type VisitOptions,
	withQuery,
} from "../router.js";

// ─── The page ────────────────────────────────────────────────────────────

const PageContext = createContext<PhotonPageData | null>(null);

/**
 * Provide the page to the components below it — in the SSR entry, where there
 * is no router: `createElement(PhotonPage, { page: pageData }, …)`.
 */
export function PhotonPage({
	page,
	children,
}: {
	page: PhotonPageData;
	children?: ReactNode;
}): ReactNode {
	return createElement(PageContext.Provider, { value: page }, children);
}

/** The page on screen; re-renders when a visit or a partial reload changes it. */
export function usePage(): PhotonPageData {
	const provided = useContext(PageContext);
	const current = useSyncExternalStore(
		subscribeToPage,
		getCurrentPage,
		getCurrentPage,
	);
	const page = provided ?? current;
	if (page === undefined) {
		throw new Error(
			"usePage must be used within a Photon page — or, on the server, inside <PhotonPage page={pageData}>.",
		);
	}
	return page;
}

/** `get(props, path)` for a dotted prop name. */
function propAt(props: Record<string, unknown>, path: string): unknown {
	let value: unknown = props;
	for (const segment of path.split(".")) {
		if (typeof value !== "object" || value === null) return undefined;
		value = Reflect.get(value, segment);
	}
	return value;
}

function sameUrlWithoutQueryOrHash(url: string): boolean {
	const a = new URL(url, window.location.href);
	return (
		a.origin === window.location.origin &&
		a.pathname === window.location.pathname
	);
}

type Slot<P> = ReactNode | ((props: P) => ReactNode);

function renderSlot<P>(slot: Slot<P> | undefined, props: P): ReactNode {
	return typeof slot === "function" ? slot(props) : (slot ?? null);
}

// ─── Deferred ────────────────────────────────────────────────────────────

export interface DeferredProps {
	/** The deferred prop, or props, to wait for. */
	data: string | string[];
	/** Shown until they arrive. */
	fallback: ReactNode | (() => ReactNode);
	/** Shown instead when the server rescued one of them after it failed. */
	rescue?: Slot<{ reloading: boolean }>;
	children?: Slot<{ reloading: boolean }>;
}

/** Its children once every prop in `data` is on the page; the fallback until then. */
export function Deferred({
	children,
	data,
	rescue,
	fallback,
}: DeferredProps): ReactNode {
	if (!data) {
		throw new Error(
			"`<Deferred>` requires a `data` prop to be a string or array of strings",
		);
	}
	if (!fallback) throw new Error("`<Deferred>` requires a `fallback` prop");
	const [reloading, setReloading] = useState(false);
	const activeReloads = useRef(new Set<Visit>());
	const page = usePage();
	const keys = useMemo(() => (Array.isArray(data) ? data : [data]), [data]);
	const rescuedKeys = useMemo(
		() => new Set(page.rescuedProps ?? []),
		[page.rescuedProps],
	);

	useEffect(() => {
		// A partial reload asking again for these props is a reload, not a first
		// load: the children stay and say so.
		const reloads = (visit: Visit): boolean =>
			visit.preserveState &&
			sameUrlWithoutQueryOrHash(visit.url) &&
			keys.some((key) => partialReloadRequestsProp(visit, key));
		const offStart = router.on("start", (event) => {
			const { visit } = event.detail;
			if (reloads(visit)) {
				activeReloads.current.add(visit);
				setReloading(true);
			}
		});
		const offFinish = router.on("finish", (event) => {
			// The same object `start` carried: one visit, one entry.
			if (activeReloads.current.delete(event.detail.visit)) {
				setReloading(activeReloads.current.size > 0);
			}
		});
		return () => {
			offStart();
			offFinish();
			activeReloads.current.clear();
		};
	}, [keys]);

	const defined = keys.every((key) => propAt(page.props, key) !== undefined);
	const rescued = keys.some((key) => rescuedKeys.has(key));
	if (defined && !rescued) return renderSlot(children, { reloading });
	if (rescued && rescue) return renderSlot(rescue, { reloading });
	return typeof fallback === "function" ? fallback() : fallback;
}

// ─── WhenVisible ─────────────────────────────────────────────────────────

export interface WhenVisibleProps {
	/** The prop, or props, to load once the element scrolls into view. */
	data?: string | string[];
	/** Extra reload options, merged under `only`. */
	params?: PartialRequest;
	/** How far from the viewport to start loading, in pixels. */
	buffer?: number;
	/** The wrapper element while waiting. Default `div`. */
	as?: ElementType;
	/** Load every time it comes into view, not only the first. */
	always?: boolean;
	fallback?: ReactNode | (() => ReactNode);
	children?: Slot<{ fetching: boolean }>;
}

/** Load `data` when this scrolls into view; the fallback until it has. */
export function WhenVisible({
	children,
	data,
	params,
	buffer,
	as = "div",
	always = false,
	fallback = null,
}: WhenVisibleProps): ReactNode {
	const pageProps = usePage().props;
	const keys = useMemo(
		() => (data ? (Array.isArray(data) ? data : [data]) : []),
		[data],
	);
	const [loaded, setLoaded] = useState(
		() =>
			keys.length > 0 &&
			keys.every((key) => propAt(pageProps, key) !== undefined),
	);
	const [isFetching, setIsFetching] = useState(false);
	const fetching = useRef(false);
	const ref = useRef<HTMLElement | null>(null);
	const observer = useRef<IntersectionObserver | null>(null);
	const reloadParams = useRef<() => PartialRequest>(() => ({}));

	useEffect(() => {
		if (keys.length > 0) {
			setLoaded(keys.every((key) => propAt(pageProps, key) !== undefined));
		}
	}, [pageProps, keys]);

	reloadParams.current = () => ({
		preserveErrors: true,
		...params,
		...(data ? { only: Array.isArray(data) ? data : [data] } : {}),
	});

	useEffect(() => {
		const element = ref.current;
		if (!element || (loaded && !always)) return;
		observer.current?.disconnect();
		observer.current = new IntersectionObserver(
			(entries) => {
				if (!entries[0]?.isIntersecting) return;
				if (fetching.current || (!always && loaded)) return;
				fetching.current = true;
				setIsFetching(true);
				const request = reloadParams.current();
				void router.reload({
					...request,
					onFinish: (visit) => {
						setLoaded(true);
						fetching.current = false;
						setIsFetching(false);
						request.onFinish?.(visit);
						if (!always) observer.current?.disconnect();
					},
				});
			},
			{ rootMargin: `${buffer || 0}px` },
		);
		observer.current.observe(element);
		return () => observer.current?.disconnect();
	}, [always, loaded, buffer]);

	const content = (): ReactNode =>
		renderSlot(children, { fetching: isFetching });
	if (always || !loaded) {
		return createElement(
			as,
			{ ref },
			loaded
				? content()
				: typeof fallback === "function"
					? fallback()
					: fallback,
		);
	}
	return content();
}

// ─── InfiniteScroll ──────────────────────────────────────────────────────

/** What a trigger slot (`previous` / `next`) is given. */
export interface InfiniteScrollActionSlotProps {
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

/** What the list's own children are given. */
export interface InfiniteScrollSlotProps {
	loading: boolean;
	loadingPrevious: boolean;
	loadingNext: boolean;
}

/** The methods a ref to `<InfiniteScroll>` exposes. */
export interface InfiniteScrollRef {
	fetchNext: () => void;
	fetchPrevious: () => void;
	hasPrevious: () => boolean;
	hasNext: () => boolean;
}

type ElementReference = string | RefObject<HTMLElement | null> | undefined;

export interface InfiniteScrollProps
	extends Omit<HTMLAttributes<HTMLElement>, "children"> {
	/** The scroll prop. */
	data: string;
	/** Trigger distance from the viewport, in pixels. */
	buffer?: number;
	/** The list element. Default `div`. */
	as?: ElementType;
	/** Never load on scroll: the trigger slots offer `fetch`. */
	manual?: boolean;
	/** Load on scroll this many times, then switch to manual. */
	manualAfter?: number;
	/** Keep the URL as it is instead of following the visible page. */
	preserveUrl?: boolean;
	/** Newest at the bottom: the list loads older rows upward. */
	reverse?: boolean;
	/** Scroll to the bottom on mount (default: `reverse`). */
	autoScroll?: boolean;
	startElement?: ElementReference;
	endElement?: ElementReference;
	itemsElement?: ElementReference;
	previous?: Slot<InfiniteScrollActionSlotProps>;
	next?: Slot<InfiniteScrollActionSlotProps>;
	loading?: Slot<InfiniteScrollActionSlotProps>;
	/** Extra reload options for every page request. */
	params?: PartialRequest;
	onlyNext?: boolean;
	onlyPrevious?: boolean;
	children?: Slot<InfiniteScrollSlotProps>;
}

function resolveElement(
	value: ElementReference,
	fallback: HTMLElement | null,
): HTMLElement | null {
	if (!value) return fallback;
	if (typeof value === "string") {
		const found = document.querySelector(value);
		return found instanceof HTMLElement ? found : fallback;
	}
	return value.current;
}

function InfiniteScrollComponent(
	{
		data,
		buffer = 0,
		as = "div",
		manual = false,
		manualAfter = 0,
		preserveUrl = false,
		reverse = false,
		autoScroll,
		children,
		startElement,
		endElement,
		itemsElement,
		previous,
		next,
		loading,
		params = {},
		onlyNext = false,
		onlyPrevious = false,
		...props
	}: InfiniteScrollProps,
	ref: ForwardedRef<InfiniteScrollRef>,
): ReactNode {
	const [startFromRef, setStartFromRef] = useState<HTMLElement | null>(null);
	const startRef = useCallback(
		(node: HTMLElement | null) => setStartFromRef(node),
		[],
	);
	const [endFromRef, setEndFromRef] = useState<HTMLElement | null>(null);
	const endRef = useCallback(
		(node: HTMLElement | null) => setEndFromRef(node),
		[],
	);
	const [itemsFromRef, setItemsFromRef] = useState<HTMLElement | null>(null);
	const itemsRef = useCallback(
		(node: HTMLElement | null) => setItemsFromRef(node),
		[],
	);

	const scrollProp = usePage().scrollProps?.[data];
	const [loadingPrevious, setLoadingPrevious] = useState(false);
	const [loadingNext, setLoadingNext] = useState(false);
	const [requestCount, setRequestCount] = useState(0);
	const [hasPreviousPage, setHasPreviousPage] = useState(
		scrollProp?.previousPage != null,
	);
	const [hasNextPage, setHasNextPage] = useState(scrollProp?.nextPage != null);

	const resolvedStart = startElement
		? resolveElement(startElement, startFromRef)
		: startFromRef;
	const resolvedEnd = endElement
		? resolveElement(endElement, endFromRef)
		: endFromRef;
	const resolvedItems = itemsElement
		? resolveElement(itemsElement, itemsFromRef)
		: itemsFromRef;
	const scrollableParent = useMemo(
		() => getScrollableParent(resolvedItems),
		[resolvedItems],
	);

	const callbackProps = useRef({
		buffer,
		onlyNext,
		onlyPrevious,
		reverse,
		preserveUrl,
		params,
	});
	callbackProps.current = {
		buffer,
		onlyNext,
		onlyPrevious,
		reverse,
		preserveUrl,
		params,
	};

	const [instance, setInstance] = useState<UseInfiniteScrollProps | null>(null);
	const dataManager: InfiniteScrollData | undefined = instance?.dataManager;
	const elementManager: InfiniteScrollElementManager | undefined =
		instance?.elementManager;

	const manualMode = manual || (manualAfter > 0 && requestCount >= manualAfter);
	const autoLoad = !manualMode;
	const autoLoadRef = useRef(autoLoad);
	autoLoadRef.current = autoLoad;

	useEffect(() => {
		if (!resolvedItems) return;
		const scroll = createInfiniteScroll({
			getPropName: () => data,
			inReverseMode: () => callbackProps.current.reverse,
			shouldFetchNext: () => !callbackProps.current.onlyPrevious,
			shouldFetchPrevious: () => !callbackProps.current.onlyNext,
			shouldPreserveUrl: () => callbackProps.current.preserveUrl,
			getReloadOptions: () => callbackProps.current.params,
			getTriggerMargin: () => callbackProps.current.buffer,
			getStartElement: () => resolvedStart,
			getEndElement: () => resolvedEnd,
			getItemsElement: () => resolvedItems,
			getScrollableParent: () => scrollableParent,
			onBeforePreviousRequest: () => setLoadingPrevious(true),
			onBeforeNextRequest: () => setLoadingNext(true),
			onCompletePreviousRequest: ({ completed }) => {
				setLoadingPrevious(false);
				if (completed) sync();
			},
			onCompleteNextRequest: ({ completed }) => {
				setLoadingNext(false);
				if (completed) sync();
			},
			onDataReset: () => sync(),
		});
		function sync(): void {
			setRequestCount(scroll.dataManager.getRequestCount());
			setHasPreviousPage(scroll.dataManager.hasPrevious());
			setHasNextPage(scroll.dataManager.hasNext());
		}
		setInstance(scroll);
		sync();
		scroll.elementManager.setupObservers();
		scroll.elementManager.processServerLoadedElements(
			scroll.dataManager.getLastLoadedPage(),
		);
		if (autoLoadRef.current) scroll.elementManager.enableTriggers();
		return () => {
			scroll.flush();
			setInstance(null);
		};
	}, [data, resolvedItems, resolvedStart, resolvedEnd, scrollableParent]);

	// Re-evaluated whenever a side is switched on or off: `enableTriggers` asks
	// `shouldFetchNext` / `shouldFetchPrevious`, which read them through
	// `callbackProps`. Both off leaves nothing to observe.
	const sides = `${onlyNext}:${onlyPrevious}`;
	useEffect(() => {
		if (autoLoad && sides !== "true:true") elementManager?.enableTriggers();
		else elementManager?.disableTriggers();
	}, [autoLoad, sides, elementManager]);

	// Once, when the list finds its scroll container — as upstream does; a later
	// change of `reverse` does not jump the reader to the bottom.
	const scrollToBottomOnMount = useRef(autoScroll ?? reverse);
	scrollToBottomOnMount.current = autoScroll ?? reverse;
	useEffect(() => {
		if (scrollToBottomOnMount.current) {
			if (scrollableParent) {
				scrollableParent.scrollTo({
					top: scrollableParent.scrollHeight,
					behavior: "instant",
				});
			} else {
				window.scrollTo({
					top: document.body.scrollHeight,
					behavior: "instant",
				});
			}
		}
	}, [scrollableParent]);

	useImperativeHandle(
		ref,
		() => ({
			fetchNext: () => void dataManager?.fetchNext(),
			fetchPrevious: () => void dataManager?.fetchPrevious(),
			hasPrevious: () => dataManager?.hasPrevious() ?? false,
			hasNext: () => dataManager?.hasNext() ?? false,
		}),
		[dataManager],
	);

	const headerAutoMode = autoLoad && !onlyNext;
	const footerAutoMode = autoLoad && !onlyPrevious;
	const shared = {
		loadingPrevious,
		loadingNext,
		hasPrevious: hasPreviousPage,
		hasNext: hasNextPage,
	};
	const exposedPrevious: InfiniteScrollActionSlotProps = {
		loading: loadingPrevious,
		fetch: () => void dataManager?.fetchPrevious(),
		autoMode: headerAutoMode,
		manualMode: !headerAutoMode,
		hasMore: hasPreviousPage,
		...shared,
	};
	const exposedNext: InfiniteScrollActionSlotProps = {
		loading: loadingNext,
		fetch: () => void dataManager?.fetchNext(),
		autoMode: footerAutoMode,
		manualMode: !footerAutoMode,
		hasMore: hasNextPage,
		...shared,
	};
	const exposedSlot: InfiniteScrollSlotProps = {
		loading: loadingPrevious || loadingNext,
		loadingPrevious,
		loadingNext,
	};

	const elements: ReactNode[] = [];
	if (!startElement) {
		elements.push(
			createElement(
				"div",
				{ ref: startRef, key: "start" },
				previous !== undefined
					? renderSlot(previous, exposedPrevious)
					: loadingPrevious
						? renderSlot(loading, exposedPrevious)
						: null,
			),
		);
	}
	elements.push(
		createElement(
			as,
			{ ...props, ref: itemsRef, key: "items" },
			renderSlot(children, exposedSlot),
		),
	);
	if (!endElement) {
		elements.push(
			createElement(
				"div",
				{ ref: endRef, key: "end" },
				next !== undefined
					? renderSlot(next, exposedNext)
					: loadingNext
						? renderSlot(loading, exposedNext)
						: null,
			),
		);
	}
	return createElement(
		Fragment,
		null,
		...(reverse ? [...elements].reverse() : elements),
	);
}

/** A list that loads the pages of a scroll prop as the reader reaches them. */
export const InfiniteScroll = forwardRef(InfiniteScrollComponent);

// ─── Link ────────────────────────────────────────────────────────────────

/**
 * Whether a click is the router's to handle — `shouldIntercept` in
 * `@inertiajs/core`: not when the page already handled it, and not a
 * modified or non-left click on a link, nor one aimed at another window.
 */
export function shouldIntercept(event: {
	currentTarget: EventTarget | null;
	target: EventTarget | null;
	defaultPrevented: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	button?: number;
}): boolean {
	const element = event.currentTarget;
	const isLink = element instanceof HTMLAnchorElement;
	const editable =
		event.target instanceof HTMLElement && event.target.isContentEditable;
	if (editable || event.defaultPrevented) return false;
	if (!isLink) return true;
	const target = element.target;
	return !(
		event.altKey ||
		event.ctrlKey ||
		event.metaKey ||
		event.shiftKey ||
		(target !== "" && target !== "_self") ||
		(event.button !== undefined && event.button !== 0)
	);
}

export interface LinkProps
	extends Omit<HTMLAttributes<HTMLElement>, "onClick" | "onError"> {
	href: string;
	/** The element rendered. Default `a` — a `button` for any other method than GET. */
	as?: ElementType;
	method?: Method;
	data?: RequestPayload;
	replace?: boolean;
	preserveState?: boolean;
	preserveUrl?: boolean;
	only?: string[];
	except?: string[];
	headers?: Record<string, string>;
	errorBag?: string;
	onClick?: (event: MouseEvent<HTMLElement>) => void;
	onBefore?: VisitOptions["onBefore"];
	onStart?: VisitOptions["onStart"];
	onSuccess?: VisitOptions["onSuccess"];
	onError?: VisitOptions["onError"];
	onFinish?: VisitOptions["onFinish"];
	children?: ReactNode;
}

function LinkComponent(
	{
		children,
		as = "a",
		data = {},
		href,
		method = "get",
		preserveState,
		preserveUrl = false,
		replace = false,
		only = [],
		except = [],
		headers = {},
		errorBag,
		onClick,
		onBefore,
		onStart,
		onSuccess,
		onError,
		onFinish,
		...props
	}: LinkProps,
	ref: ForwardedRef<HTMLElement>,
): ReactNode {
	const [inFlight, setInFlight] = useState(0);
	const verb: Method = method;
	// A link that changes something is a button, as upstream renders it: an
	// anchor would be followed by crawlers and opened in new tabs as a GET.
	const element =
		typeof as === "string" && as.toLowerCase() === "a" && verb !== "get"
			? "button"
			: as;
	const url = verb === "get" ? withQuery(href, data) : href;

	const visit = (): void => {
		void router.visit(url, {
			method: verb,
			...(verb === "get" ? {} : { data }),
			preserveState: preserveState ?? verb !== "get",
			preserveUrl,
			replace,
			only,
			except,
			headers,
			errorBag,
			onBefore,
			onStart: (started) => {
				setInFlight((count) => count + 1);
				onStart?.(started);
			},
			onSuccess,
			onError,
			onFinish: (finished) => {
				setInFlight((count) => count - 1);
				onFinish?.(finished);
			},
		});
	};

	const buttonProps: { type: "button" } = { type: "button" };
	const elementProps =
		element === "button"
			? buttonProps
			: element === "a" || typeof element !== "string"
				? { href: url }
				: {};
	return createElement(
		element,
		{
			...props,
			...elementProps,
			ref,
			onClick: (event: MouseEvent<HTMLElement>) => {
				onClick?.(event);
				if (shouldIntercept(event)) {
					event.preventDefault();
					visit();
				}
			},
			"data-loading": inFlight > 0 ? "" : undefined,
		},
		children,
	);
}

/**
 * A link the router follows without a page load — `Link` from
 * `@inertiajs/react` 3.7.1, without prefetching (Photon has no visit cache).
 */
export const Link = forwardRef(LinkComponent);

// ─── useForm ─────────────────────────────────────────────────────────────

type FormValues = Record<string, unknown>;

/** What `useForm` returns: the form's state, and what changes or submits it. */
export type InertiaFormProps<T extends FormValues> = FormState<T> &
	Omit<FormStore<T>, "getSnapshot" | "subscribe" | "dispose">;

/**
 * A form's data, errors and submission state — `useForm` from
 * `@inertiajs/react` 3.7.1: `form.data`, `form.setData`, `form.post(url)`,
 * `form.errors`, `form.processing`, `form.isDirty`, `form.reset()`… Pass a
 * key first to keep the data and errors in history (`useForm('Signup', {…})`).
 * The logic is Photon's framework-free form core (`../form.ts`).
 */
export function useForm<T extends FormValues>(
	data: T | (() => T),
): InertiaFormProps<T>;
export function useForm<T extends FormValues>(
	rememberKey: string,
	data: T | (() => T),
): InertiaFormProps<T>;
export function useForm<T extends FormValues>(
	keyOrData: string | T | (() => T),
	maybeData?: T | (() => T),
): InertiaFormProps<T> {
	const [store] = useState(() => {
		if (typeof keyOrData === "string") {
			if (maybeData === undefined) {
				throw new Error("useForm(rememberKey, data) needs the data too.");
			}
			return createForm(maybeData, { rememberKey: keyOrData });
		}
		return createForm(keyOrData);
	});
	const state = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getSnapshot,
	);
	useEffect(() => () => store.dispose(), [store]);
	return {
		...state,
		setData: store.setData,
		setDefaults: store.setDefaults,
		reset: store.reset,
		setError: store.setError,
		clearErrors: store.clearErrors,
		resetAndClearErrors: store.resetAndClearErrors,
		transform: store.transform,
		submit: store.submit,
		get: store.get,
		post: store.post,
		put: store.put,
		patch: store.patch,
		delete: store.delete,
		cancel: store.cancel,
	};
}

// ─── Form ────────────────────────────────────────────────────────────────

const FormContext = createContext<FormSlotProps | undefined>(undefined);

export interface FormProps
	extends FormComponentOptions,
		Omit<
			FormHTMLAttributes<HTMLFormElement>,
			"action" | "method" | "children" | "onError" | "onSubmit" | "onReset"
		> {
	/** Make the form inert while it submits. */
	disableWhileProcessing?: boolean;
	children?: ReactNode | ((form: FormSlotProps) => ReactNode);
}

function FormComponent(
	{
		children,
		disableWhileProcessing = false,
		action = "",
		method = "get",
		headers,
		errorBag,
		transform,
		options,
		onBefore,
		onStart,
		onSuccess,
		onError,
		onFinish,
		onCancel,
		onCancelToken,
		onSubmitComplete,
		resetOnSuccess,
		resetOnError,
		setDefaultsOnSuccess,
		cancelOnUnmount,
		...props
	}: FormProps,
	ref: ForwardedRef<FormSlotProps>,
): ReactNode {
	const latest = useRef<FormComponentOptions>({});
	latest.current = {
		action,
		method,
		headers,
		errorBag,
		transform,
		options,
		onBefore,
		onStart,
		onSuccess,
		onError,
		onFinish,
		onCancel,
		onCancelToken,
		onSubmitComplete,
		resetOnSuccess,
		resetOnError,
		setDefaultsOnSuccess,
		cancelOnUnmount,
	};
	const [controller] = useState(() =>
		createFormController(() => latest.current),
	);
	const exposed = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot,
	);
	const element = useRef<HTMLFormElement | null>(null);
	useEffect(() => {
		if (element.current) controller.mount(element.current);
		return () => controller.unmount();
	}, [controller]);
	useImperativeHandle(ref, () => exposed, [exposed]);
	return createElement(
		FormContext.Provider,
		{ value: exposed },
		createElement(
			"form",
			{
				...props,
				ref: element,
				action,
				method,
				onSubmit: (event: FormEvent<HTMLFormElement>) => {
					event.preventDefault();
					const native = event.nativeEvent;
					exposed.submit(
						native instanceof SubmitEvent ? native.submitter : null,
					);
				},
				inert: disableWhileProcessing && exposed.processing,
			},
			typeof children === "function" ? children(exposed) : children,
		),
	);
}

/**
 * A form the router submits — `Form` from `@inertiajs/react` 3.7.1: the data
 * is read from its fields at submit, and its children (or a render function)
 * get `errors`, `processing`, `isDirty`, `reset`, `submit`… The same object
 * is on its ref and in `useFormContext()` below it.
 */
export const Form = forwardRef(FormComponent);

/** The nearest `<Form>`'s state and methods, or undefined outside one. */
export function useFormContext(): FormSlotProps | undefined {
	return useContext(FormContext);
}
