import type { Component, Snippet } from "svelte";
import type { PhotonAppSsrResponse, ResolvePage } from "../app.js";
import type { FormErrors, FormStore } from "../form.js";
import type { FormComponentOptions, FormSlotProps } from "../formElement.js";
import type { RouteName } from "../routes.js";
import type { PhotonPageData } from "../hydrate.js";
import type {
	Method,
	PartialRequest,
	RequestPayload,
	VisitOptions,
} from "../router.js";

/** The page Photon's Svelte root renders. */
export interface PhotonRootProps {
	component: unknown;
	props: Record<string, unknown>;
	/** On the server: the whole page, which `usePage()` then returns. */
	page?: PhotonPageData;
}

/**
 * Photon's root component for Svelte 5 — pass it to `hydrate({ svelteRoot })`
 * and render it in the SSR entry, so a page keeps its state when its props
 * change.
 */
declare const PhotonRoot: Component<
	PhotonRootProps,
	{ setPage(next: { component: unknown; props: Record<string, unknown> }): void }
>;
export default PhotonRoot;
export { PhotonRoot, PhotonRoot as App };

export interface SetupOptions<El> {
	/** The element the page is in; null on the server. */
	el: El;
	App: typeof PhotonRoot;
	props: PhotonRootProps;
}

export interface CreatePhotonAppOptions {
	/** The id of the element the page is in. Default: `'app'`. */
	id?: string;
	resolve: ResolvePage;
	/**
	 * Mount `App` into `el`. Without it, `App` is hydrated when the server
	 * rendered the page, and mounted otherwise.
	 */
	setup?(options: SetupOptions<HTMLElement>): void;
}

export interface CreatePhotonAppSsrOptions {
	/** The page to render — what the SSR entry's `render(page)` receives. */
	page: PhotonPageData;
	resolve: ResolvePage;
	/** `render(App, { props })` from `svelte/server`. */
	setup(
		options: SetupOptions<null>,
	):
		| { head?: string; body: string }
		| Promise<{ head?: string; body: string }>;
}

/**
 * Start a Photon app. In the browser (no `page`), read the page the server
 * sent, mount `App`, and start the router. In the SSR entry (with `page`),
 * render it through `setup` and return `{ head, body }` — what the entry's
 * default export gives Photon.
 */
export declare function createPhotonApp(
	options: CreatePhotonAppSsrOptions,
): Promise<PhotonAppSsrResponse>;
export declare function createPhotonApp(
	options: CreatePhotonAppOptions,
): Promise<void>;

/** The page on screen; its fields follow every visit. */
export declare function usePage(): PhotonPageData;
/** Make `next` the page (what `PhotonRoot` does on the server). */
export declare function setPage(next: PhotonPageData): void;

export declare const Deferred: Component<{
	data: string | string[];
	rescue?: Snippet<[{ reloading: boolean }]>;
	fallback?: Snippet;
	children?: Snippet<[{ reloading: boolean }]>;
}>;

export declare const WhenVisible: Component<{
	data?: string | string[];
	params?: PartialRequest;
	buffer?: number;
	as?: keyof HTMLElementTagNameMap;
	always?: boolean;
	children?: Snippet<[{ fetching: boolean }]>;
	fallback?: Snippet;
}>;

interface InfiniteScrollActionSlotProps {
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

export declare const InfiniteScroll: Component<
	{
		data: string;
		buffer?: number;
		as?: keyof HTMLElementTagNameMap;
		manual?: boolean;
		manualAfter?: number;
		preserveUrl?: boolean;
		reverse?: boolean;
		autoScroll?: boolean;
		startElement?: string | (() => HTMLElement | null) | null;
		endElement?: string | (() => HTMLElement | null) | null;
		itemsElement?: string | (() => HTMLElement | null) | null;
		params?: PartialRequest;
		onlyNext?: boolean;
		onlyPrevious?: boolean;
		previous?: Snippet<[InfiniteScrollActionSlotProps]>;
		loading?: Snippet<[InfiniteScrollActionSlotProps]>;
		next?: Snippet<[InfiniteScrollActionSlotProps]>;
		children?: Snippet<
			[{ loading: boolean; loadingPrevious: boolean; loadingNext: boolean }]
		>;
		[key: string]: unknown;
	},
	{
		fetchPrevious(options?: PartialRequest): void;
		fetchNext(options?: PartialRequest): void;
		hasPrevious(): boolean;
		hasNext(): boolean;
	}
>;

/** A link the router follows without a page load; a button for any method but GET. */
export declare const Link: Component<{
	href?: string;
	route?: RouteName;
	routeParams?: Record<string, string | number>;
	qs?: Record<string, string | number | boolean>;
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
}>;

type FormFields = Record<string, unknown>;

/** The state and methods a Svelte form carries beside its fields. */
export interface InertiaFormExtras<T extends FormFields>
	extends Omit<
		FormStore<T>,
		"getSnapshot" | "subscribe" | "dispose" | "setData" | "transform"
	> {
	data(): T;
	transform(callback: (data: T) => Record<string, unknown> | FormData): InertiaForm<T>;
	readonly errors: FormErrors;
	readonly hasErrors: boolean;
	readonly processing: boolean;
	readonly progress: null;
	readonly isDirty: boolean;
	readonly wasSuccessful: boolean;
	readonly recentlySuccessful: boolean;
}

/** The form: its fields at the top level (`bind:value={form.email}`). */
export type InertiaForm<T extends FormFields> = T & InertiaFormExtras<T>;

export declare function useForm<T extends FormFields>(data: T | (() => T)): InertiaForm<T>;
export declare function useForm<T extends FormFields>(
	rememberKey: string,
	data: T | (() => T),
): InertiaForm<T>;

/** A form the router submits; its children get the form's state and methods. */
export declare const Form: Component<
	FormComponentOptions & {
		disableWhileProcessing?: boolean;
		children?: Snippet<[FormSlotProps]>;
		[key: string]: unknown;
	},
	{
		submit(submitter?: HTMLElement | null): void;
		reset(...fields: string[]): void;
		clearErrors(...fields: string[]): void;
		cancel(): void;
		defaults(): void;
		getData(): Record<string, unknown>;
		getFormData(): FormData;
	}
>;

/** The nearest `<Form>`'s state and methods, or undefined outside one. */
export declare function useFormContext(): FormSlotProps | undefined;
