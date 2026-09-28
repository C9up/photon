/// <reference lib="dom" />
/**
 * Photon's Vue components — `@c9up/photon/vue`.
 *
 * `usePage`, `Deferred`, `WhenVisible` and `InfiniteScroll`, ported from
 * `@inertiajs/vue3` 3.7.1 (read from its source) onto Photon's router: same
 * props, same slots (`fallback`, `rescue`, `previous`, `next`, `loading`),
 * same behaviour.
 *
 * The page comes from the router's store in the browser and, on the server,
 * from `<PhotonPage :page="pageData">` around the page in the SSR entry —
 * Inertia's `App` provides it on both sides; Photon renders the page component
 * itself. Only a Vue app imports this module.
 */

import {
	computed,
	defineComponent,
	Fragment,
	getCurrentScope,
	h,
	type InjectionKey,
	inject,
	nextTick,
	onMounted,
	onScopeDispose,
	onUnmounted,
	provide,
	reactive,
	ref,
	type ShallowRef,
	shallowRef,
	type VNodeChild,
	watch,
} from "vue";
import { createForm, type FormErrors, type FormStore } from "../form.js";
import {
	createFormController,
	type FormComponentOptions,
	type FormSlotProps,
} from "../formElement.js";
import type { PhotonPageData } from "../hydrate.js";
import {
	useInfiniteScroll as createInfiniteScroll,
	getScrollableParent,
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

const PAGE_KEY: InjectionKey<PhotonPageData> = Symbol("photon:page");

/** The router's page, as a ref every `usePage()` reads. */
let storePage: ShallowRef<PhotonPageData | undefined> | undefined;

function pageRef(): ShallowRef<PhotonPageData | undefined> {
	if (storePage === undefined) {
		const page = shallowRef(getCurrentPage());
		subscribeToPage((next) => {
			page.value = next;
		});
		storePage = page;
	}
	return storePage;
}

/**
 * Provide the page to the components below it — in the SSR entry, where there
 * is no router: `h(PhotonPage, { page: pageData }, () => h(Page, pageData.props))`.
 */
export const PhotonPage = defineComponent(
	(props: { page: PhotonPageData }, { slots }) => {
		provide(PAGE_KEY, props.page);
		return () => slots.default?.();
	},
	{ props: ["page"] },
);

/**
 * The page on screen, as a reactive object whose fields follow every visit —
 * the shape of `usePage()` in `@inertiajs/vue3`.
 */
export function usePage() {
	const provided = inject(PAGE_KEY, null);
	const store = pageRef();
	const page = computed(() => provided ?? store.value);
	return reactive({
		props: computed(() => page.value?.props ?? {}),
		url: computed(() => page.value?.url),
		component: computed(() => page.value?.component),
		version: computed(() => page.value?.version),
		clearHistory: computed(() => page.value?.clearHistory),
		encryptHistory: computed(() => page.value?.encryptHistory),
		deferredProps: computed(() => page.value?.deferredProps),
		rescuedProps: computed(() => page.value?.rescuedProps),
		mergeProps: computed(() => page.value?.mergeProps),
		prependProps: computed(() => page.value?.prependProps),
		deepMergeProps: computed(() => page.value?.deepMergeProps),
		matchPropsOn: computed(() => page.value?.matchPropsOn),
		onceProps: computed(() => page.value?.onceProps),
		scrollProps: computed(() => page.value?.scrollProps),
		rememberedState: computed(() => page.value?.rememberedState),
		flash: computed(() => page.value?.flash),
	});
}

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

// ─── Deferred ────────────────────────────────────────────────────────────

/**
 * The default slot once every prop in `data` is on the page, the `fallback`
 * slot until then, and `rescue` when the server rescued one of them.
 */
export const Deferred = defineComponent(
	(props: { data: string | string[] }, { slots }) => {
		const reloading = ref(false);
		const activeReloads = new Set<Visit>();
		const page = usePage();
		const keys = computed(() =>
			Array.isArray(props.data) ? props.data : [props.data],
		);
		const rescuedKeys = computed(() => new Set(page.rescuedProps ?? []));
		let offStart: (() => void) | undefined;
		let offFinish: (() => void) | undefined;
		onMounted(() => {
			offStart = router.on("start", (event) => {
				const { visit } = event.detail;
				if (
					visit.preserveState &&
					sameUrlWithoutQueryOrHash(visit.url) &&
					keys.value.some((key) => partialReloadRequestsProp(visit, key))
				) {
					activeReloads.add(visit);
					reloading.value = true;
				}
			});
			offFinish = router.on("finish", (event) => {
				if (activeReloads.delete(event.detail.visit)) {
					reloading.value = activeReloads.size > 0;
				}
			});
		});
		onUnmounted(() => {
			offStart?.();
			offFinish?.();
			activeReloads.clear();
		});
		return () => {
			if (!slots.fallback) {
				throw new Error("`<Deferred>` requires a `<template #fallback>` slot");
			}
			const defined = keys.value.every(
				(key) => propAt(page.props, key) !== undefined,
			);
			const rescued = keys.value.some((key) => rescuedKeys.value.has(key));
			const slotProps = { reloading: reloading.value };
			if (defined && !rescued) {
				return h(
					Fragment,
					{ key: "default" },
					slots.default?.(slotProps) ?? [],
				);
			}
			if (rescued && slots.rescue) {
				return h(Fragment, { key: "rescue" }, slots.rescue(slotProps));
			}
			return h(Fragment, { key: "fallback" }, slots.fallback({}));
		};
	},
	{ name: "Deferred", props: ["data"] },
);

// ─── WhenVisible ─────────────────────────────────────────────────────────

/** Load `data` when this scrolls into view; the `fallback` slot until it has. */
export const WhenVisible = defineComponent(
	(
		props: {
			data?: string | string[];
			params?: PartialRequest;
			buffer?: number;
			as?: string;
			always?: boolean;
		},
		{ slots },
	) => {
		const loaded = ref(false);
		const fetching = ref(false);
		const observer = ref<IntersectionObserver | null>(null);
		const element = ref<HTMLElement | null>(null);
		const page = usePage();
		const keys = computed(() =>
			props.data ? (Array.isArray(props.data) ? props.data : [props.data]) : [],
		);

		function reloadParams(): PartialRequest {
			return {
				preserveErrors: true,
				...props.params,
				...(props.data
					? { only: Array.isArray(props.data) ? props.data : [props.data] }
					: {}),
			};
		}

		function registerObserver(): void {
			if (typeof window === "undefined") return;
			observer.value?.disconnect();
			observer.value = new IntersectionObserver(
				(entries) => {
					if (!entries[0]?.isIntersecting) return;
					if (fetching.value || (!props.always && loaded.value)) return;
					fetching.value = true;
					const request = reloadParams();
					void router.reload({
						...request,
						onFinish: (visit) => {
							loaded.value = true;
							fetching.value = false;
							request.onFinish?.(visit);
							if (!props.always) observer.value?.disconnect();
						},
					});
				},
				{ rootMargin: `${props.buffer ?? 0}px` },
			);
			if (element.value) observer.value.observe(element.value);
		}

		watch(
			() => keys.value.map((key) => propAt(page.props, key)),
			() => {
				const exists =
					keys.value.length > 0 &&
					keys.value.every((key) => propAt(page.props, key) !== undefined);
				loaded.value = exists;
				if (exists && !props.always) return;
				if (!observer.value || !exists) void nextTick(registerObserver);
			},
			{ immediate: true },
		);
		onUnmounted(() => observer.value?.disconnect());

		return () => {
			const children: VNodeChild[] = [];
			if (props.always || !loaded.value) {
				children.push(h(props.as ?? "div", { ref: element }));
			}
			if (!loaded.value) children.push(slots.fallback?.({}) ?? null);
			else if (slots.default) {
				children.push(slots.default({ fetching: fetching.value }));
			}
			return children;
		};
	},
	{ name: "WhenVisible", props: ["data", "params", "buffer", "as", "always"] },
);

// ─── InfiniteScroll ──────────────────────────────────────────────────────

type ElementReference = string | (() => HTMLElement | null) | null | undefined;

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

export interface InfiniteScrollProps {
	/** The scroll prop. */
	data: string;
	/** Trigger distance from the viewport, in pixels. */
	buffer?: number;
	onlyNext?: boolean;
	onlyPrevious?: boolean;
	/** The list element. Default `div`. */
	as?: string;
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
	itemsElement?: ElementReference;
	startElement?: ElementReference;
	endElement?: ElementReference;
	/** Extra reload options for every page request. */
	params?: PartialRequest;
}

/** A list that loads the pages of a scroll prop as the reader reaches them. */
export const InfiniteScroll = defineComponent(
	(props: InfiniteScrollProps, { slots, attrs, expose }) => {
		const itemsElementRef = ref<HTMLElement | null>(null);
		const startElementRef = ref<HTMLElement | null>(null);
		const endElementRef = ref<HTMLElement | null>(null);
		const itemsElement = computed(() =>
			resolveElement(props.itemsElement, itemsElementRef.value),
		);
		const scrollableParent = computed(() =>
			getScrollableParent(itemsElement.value),
		);
		const startElement = computed(() =>
			resolveElement(props.startElement, startElementRef.value),
		);
		const endElement = computed(() =>
			resolveElement(props.endElement, endElementRef.value),
		);
		const loadingPrevious = ref(false);
		const loadingNext = ref(false);
		const requestCount = ref(0);
		const hasPreviousPage = ref(false);
		const hasNextPage = ref(false);

		const scrollProp = usePage().scrollProps?.[props.data];
		hasPreviousPage.value = scrollProp?.previousPage != null;
		hasNextPage.value = scrollProp?.nextPage != null;

		// Only in the browser: the server has no router to reload through, and
		// the cursor above already says what the triggers will offer.
		const scroll =
			typeof window === "undefined" || getCurrentPage() === undefined
				? undefined
				: createInfiniteScroll({
						getPropName: () => props.data,
						inReverseMode: () => props.reverse ?? false,
						shouldFetchNext: () => !props.onlyPrevious,
						shouldFetchPrevious: () => !props.onlyNext,
						shouldPreserveUrl: () => props.preserveUrl ?? false,
						getReloadOptions: () => props.params ?? {},
						getTriggerMargin: () => props.buffer ?? 0,
						getStartElement: () => startElement.value,
						getEndElement: () => endElement.value,
						getItemsElement: () => itemsElement.value,
						getScrollableParent: () => scrollableParent.value,
						onBeforePreviousRequest: () => {
							loadingPrevious.value = true;
						},
						onBeforeNextRequest: () => {
							loadingNext.value = true;
						},
						onCompletePreviousRequest: ({ completed }) => {
							loadingPrevious.value = false;
							if (completed) syncState();
						},
						onCompleteNextRequest: ({ completed }) => {
							loadingNext.value = false;
							if (completed) syncState();
						},
						onDataReset: () => syncState(),
					});
		function syncState(): void {
			if (!scroll) return;
			requestCount.value = scroll.dataManager.getRequestCount();
			hasPreviousPage.value = scroll.dataManager.hasPrevious();
			hasNextPage.value = scroll.dataManager.hasNext();
		}
		syncState();

		const manualMode = computed(
			() =>
				(props.manual ?? false) ||
				((props.manualAfter ?? 0) > 0 &&
					requestCount.value >= (props.manualAfter ?? 0)),
		);
		const autoLoad = computed(() => !manualMode.value);

		const fetchNext = (): void => void scroll?.dataManager.fetchNext();
		const fetchPrevious = (): void => void scroll?.dataManager.fetchPrevious();

		onMounted(() => {
			if (!scroll) return;
			const { dataManager, elementManager } = scroll;
			elementManager.setupObservers();
			elementManager.processServerLoadedElements(
				dataManager.getLastLoadedPage(),
			);
			if (props.autoScroll ?? props.reverse) {
				const parent = scrollableParent.value;
				if (parent)
					parent.scrollTo({ top: parent.scrollHeight, behavior: "instant" });
				else
					window.scrollTo({
						top: document.body.scrollHeight,
						behavior: "instant",
					});
			}
			if (autoLoad.value) elementManager.enableTriggers();
		});
		onUnmounted(() => scroll?.flush());
		watch(
			() => [autoLoad.value, props.onlyNext, props.onlyPrevious],
			([enabled]) => {
				if (enabled) scroll?.elementManager.enableTriggers();
				else scroll?.elementManager.disableTriggers();
			},
		);

		expose({
			fetchNext,
			fetchPrevious,
			hasPrevious: () => scroll?.dataManager.hasPrevious() ?? false,
			hasNext: () => scroll?.dataManager.hasNext() ?? false,
		});

		return () => {
			const elements = [];
			const shared = {
				loadingPrevious: loadingPrevious.value,
				loadingNext: loadingNext.value,
				hasPrevious: hasPreviousPage.value,
				hasNext: hasNextPage.value,
			};
			if (!props.startElement) {
				const autoMode = autoLoad.value && !props.onlyNext;
				const exposed = {
					loading: loadingPrevious.value,
					fetch: fetchPrevious,
					autoMode,
					manualMode: !autoMode,
					hasMore: hasPreviousPage.value,
					...shared,
				};
				elements.push(
					h(
						"div",
						{ ref: startElementRef },
						slots.previous
							? slots.previous(exposed)
							: loadingPrevious.value
								? slots.loading?.(exposed)
								: undefined,
					),
				);
			}
			elements.push(
				h(
					props.as ?? "div",
					{ ...attrs, ref: itemsElementRef },
					slots.default?.({
						loading: loadingPrevious.value || loadingNext.value,
						loadingPrevious: loadingPrevious.value,
						loadingNext: loadingNext.value,
					}),
				),
			);
			if (!props.endElement) {
				const autoMode = autoLoad.value && !props.onlyPrevious;
				const exposed = {
					loading: loadingNext.value,
					fetch: fetchNext,
					autoMode,
					manualMode: !autoMode,
					hasMore: hasNextPage.value,
					...shared,
				};
				elements.push(
					h(
						"div",
						{ ref: endElementRef },
						slots.next
							? slots.next(exposed)
							: loadingNext.value
								? slots.loading?.(exposed)
								: undefined,
					),
				);
			}
			return h(
				Fragment,
				{},
				props.reverse ? [...elements].reverse() : elements,
			);
		};
	},
	{
		name: "InfiniteScroll",
		inheritAttrs: false,
		props: [
			"data",
			"buffer",
			"onlyNext",
			"onlyPrevious",
			"as",
			"manual",
			"manualAfter",
			"preserveUrl",
			"reverse",
			"autoScroll",
			"itemsElement",
			"startElement",
			"endElement",
			"params",
		],
	},
);

// ─── Link ────────────────────────────────────────────────────────────────

export interface LinkProps {
	href: string;
	/** The element rendered. Default `a` — a `button` for any other method than GET. */
	as?: string;
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
}

/** Whether a click is the router's to handle (see the React `shouldIntercept`). */
function shouldIntercept(event: MouseEvent): boolean {
	const element = event.currentTarget;
	const editable =
		event.target instanceof HTMLElement && event.target.isContentEditable;
	if (editable || event.defaultPrevented) return false;
	if (!(element instanceof HTMLAnchorElement)) return true;
	const target = element.target;
	return !(
		event.altKey ||
		event.ctrlKey ||
		event.metaKey ||
		event.shiftKey ||
		(target !== "" && target !== "_self") ||
		event.button !== 0
	);
}

/**
 * A link the router follows without a page load — `Link` from
 * `@inertiajs/vue3` 3.7.1, without prefetching (Photon has no visit cache).
 */
export const Link = defineComponent(
	(props: LinkProps, { slots, attrs }) => {
		const inFlight = ref(0);
		const method = computed<Method>(() => props.method ?? "get");
		const element = computed(() => {
			const as = props.as ?? "a";
			return as.toLowerCase() === "a" && method.value !== "get" ? "button" : as;
		});
		const url = computed(() =>
			method.value === "get" ? withQuery(props.href, props.data) : props.href,
		);
		const visit = (): void => {
			void router.visit(url.value, {
				method: method.value,
				...(method.value === "get" ? {} : { data: props.data ?? {} }),
				preserveState: props.preserveState ?? method.value !== "get",
				preserveUrl: props.preserveUrl ?? false,
				replace: props.replace ?? false,
				only: props.only ?? [],
				except: props.except ?? [],
				headers: props.headers ?? {},
				errorBag: props.errorBag,
				onBefore: props.onBefore,
				onStart: (started) => {
					inFlight.value++;
					props.onStart?.(started);
				},
				onSuccess: props.onSuccess,
				onError: props.onError,
				onFinish: (finished) => {
					inFlight.value--;
					props.onFinish?.(finished);
				},
			});
		};
		return () =>
			h(
				element.value,
				{
					...attrs,
					...(element.value === "button"
						? { type: "button" }
						: element.value === "a"
							? { href: url.value }
							: {}),
					onClick: (event: MouseEvent) => {
						if (shouldIntercept(event)) {
							event.preventDefault();
							visit();
						}
					},
					"data-loading": inFlight.value > 0 ? "" : undefined,
				},
				slots.default?.(),
			);
	},
	{
		name: "Link",
		props: [
			"href",
			"as",
			"method",
			"data",
			"replace",
			"preserveState",
			"preserveUrl",
			"only",
			"except",
			"headers",
			"errorBag",
			"onBefore",
			"onStart",
			"onSuccess",
			"onError",
			"onFinish",
		],
	},
);

// ─── useForm ─────────────────────────────────────────────────────────────

type FormFields = Record<string, unknown>;

/** The state and methods a Vue form carries beside its fields. */
export interface InertiaFormExtras<T extends FormFields>
	extends Omit<
		FormStore<T>,
		"getSnapshot" | "subscribe" | "dispose" | "setData" | "transform"
	> {
	/** The current data, as the plain object `useForm` was given. */
	data(): T;
	/** What the data becomes when it is sent; returns the form to chain. */
	transform(
		callback: (data: T) => Record<string, unknown> | FormData,
	): InertiaForm<T>;
	readonly errors: FormErrors;
	readonly hasErrors: boolean;
	readonly processing: boolean;
	readonly progress: null;
	readonly isDirty: boolean;
	readonly wasSuccessful: boolean;
	readonly recentlySuccessful: boolean;
}

/** The form: its fields at the top level (`form.email`, `v-model="form.email"`). */
export type InertiaForm<T extends FormFields> = T & InertiaFormExtras<T>;

/**
 * A form's fields, errors and submission state — `useForm` from
 * `@inertiajs/vue3` 3.7.1. The fields sit on the form itself and are
 * reactive, so `v-model="form.email"` works; `form.post(url)` submits them.
 * Pass a key first to keep data and errors in history.
 */
export function useForm<T extends FormFields>(
	data: T | (() => T),
): InertiaForm<T>;
export function useForm<T extends FormFields>(
	rememberKey: string,
	data: T | (() => T),
): InertiaForm<T>;
export function useForm<T extends FormFields>(
	keyOrData: string | T | (() => T),
	maybeData?: T | (() => T),
): InertiaForm<T> {
	let store: FormStore<T>;
	if (typeof keyOrData === "string") {
		if (maybeData === undefined) {
			throw new Error("useForm(rememberKey, data) needs the data too.");
		}
		store = createForm(maybeData, { rememberKey: keyOrData });
	} else {
		store = createForm(keyOrData);
	}
	// Every change bumps this; every getter reads it, so Vue re-renders what
	// read the form when the form changes.
	const version = shallowRef(0);
	store.subscribe(() => {
		version.value++;
	});
	if (getCurrentScope()) onScopeDispose(() => store.dispose());
	const read = () => {
		void version.value;
		return store.getSnapshot();
	};

	const extras: InertiaFormExtras<T> = {
		data: () => read().data,
		transform(callback) {
			store.transform(callback);
			return form;
		},
		setDefaults: store.setDefaults,
		reset: store.reset,
		setError: store.setError,
		clearErrors: store.clearErrors,
		resetAndClearErrors: store.resetAndClearErrors,
		submit: store.submit,
		get: store.get,
		post: store.post,
		put: store.put,
		patch: store.patch,
		delete: store.delete,
		cancel: store.cancel,
		errors: {},
		hasErrors: false,
		processing: false,
		progress: null,
		isDirty: false,
		wasSuccessful: false,
		recentlySuccessful: false,
	};
	const descriptors: PropertyDescriptorMap = {};
	for (const key of Object.keys(store.getSnapshot().data)) {
		descriptors[key] = {
			enumerable: true,
			get: () => read().data[key],
			set: (value: unknown) => store.setData(key, value),
		};
	}
	const stateKeys: Array<
		| "errors"
		| "hasErrors"
		| "processing"
		| "progress"
		| "isDirty"
		| "wasSuccessful"
		| "recentlySuccessful"
	> = [
		"errors",
		"hasErrors",
		"processing",
		"progress",
		"isDirty",
		"wasSuccessful",
		"recentlySuccessful",
	];
	for (const key of stateKeys) {
		descriptors[key] = { enumerable: true, get: () => read()[key] };
	}
	const form: InertiaForm<T> = Object.defineProperties(
		Object.assign({}, store.getSnapshot().data, extras),
		descriptors,
	);
	return form;
}

// ─── Form ────────────────────────────────────────────────────────────────

const FORM_KEY: InjectionKey<{ readonly value: FormSlotProps }> =
	Symbol("photon:form");

/**
 * A form the router submits — `Form` from `@inertiajs/vue3` 3.7.1: the data
 * is read from its fields at submit, and the default slot gets `errors`,
 * `processing`, `isDirty`, `reset`, `submit`… (also exposed on its ref and
 * through `useFormContext()`).
 */
export const Form = defineComponent(
	(
		props: FormComponentOptions & { disableWhileProcessing?: boolean },
		{ slots, attrs, expose },
	) => {
		const controller = createFormController(() => props);
		const exposed = shallowRef(controller.getSnapshot());
		const off = controller.subscribe(() => {
			exposed.value = controller.getSnapshot();
		});
		const element = ref<HTMLFormElement | null>(null);
		provide(FORM_KEY, exposed);
		onMounted(() => {
			if (element.value) controller.mount(element.value);
		});
		onUnmounted(() => {
			off();
			controller.unmount();
		});
		expose({
			submit: (submitter?: HTMLElement | null) =>
				exposed.value.submit(submitter),
			reset: (...fields: string[]) => exposed.value.reset(...fields),
			clearErrors: (...fields: string[]) =>
				exposed.value.clearErrors(...fields),
			cancel: () => exposed.value.cancel(),
			defaults: () => exposed.value.defaults(),
			getData: () => exposed.value.getData(),
			getFormData: () => exposed.value.getFormData(),
		});
		return () =>
			h(
				"form",
				{
					...attrs,
					ref: element,
					action: props.action ?? "",
					method: props.method ?? "get",
					inert:
						props.disableWhileProcessing === true && exposed.value.processing,
					onSubmit: (event: SubmitEvent) => {
						event.preventDefault();
						exposed.value.submit(event.submitter);
					},
				},
				slots.default?.(exposed.value),
			);
	},
	{
		name: "Form",
		props: [
			"action",
			"method",
			"headers",
			"errorBag",
			"transform",
			"options",
			"onBefore",
			"onStart",
			"onSuccess",
			"onError",
			"onFinish",
			"onCancel",
			"onCancelToken",
			"onSubmitComplete",
			"resetOnSuccess",
			"resetOnError",
			"setDefaultsOnSuccess",
			"cancelOnUnmount",
			"disableWhileProcessing",
		],
	},
);

/** The nearest `<Form>`'s state and methods, or undefined outside one. */
export function useFormContext(): FormSlotProps | undefined {
	return inject(FORM_KEY, undefined)?.value;
}
