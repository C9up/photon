/// <reference lib="dom" />
// This file uses browser globals. The reference pulls the DOM lib in for
// THIS file whatever `lib` the consumer configured, so a Node app
// typechecking against our sources does not trip over `window` —
// `types: "./src/index.ts"` means every consumer reads them.
/**
 * Photon — Basic SPA-nav router.
 *
 * Intercepts left-clicks on internal same-origin `<a>` elements, fetches the
 * URL with `X-Photon: true`, parses the JSON page-data response, resolves the
 * new component, and swaps the mounted root via the adapter's `update` handle.
 * Handles back/forward via `popstate`. Falls back to a full `location.href`
 * reload on any non-trivial failure (non-2xx, wrong content-type, malformed
 * JSON) — keeps user intent intact without showing a half-broken page.
 *
 * Browser-only — strict no `node:` imports.
 */

import type { MetaTags } from "../seo/Meta.js";
import type { PhotonAdapterHandle } from "./adapters/types.js";
import { applyMetaToDom } from "./applyMeta.js";
import { isPhotonState, readHistoryState, toHistoryState } from "./history.js";
import type {
	ClientFramework,
	PhotonPageData,
	ScrollPropMeta,
} from "./hydrate.js";
import {
	heldOnceKeys,
	mergePartialProps,
	type OncePropMeta,
	restoreOnceProps,
} from "./mergeProps.js";
import { type RouteTarget, resolveTarget } from "./routes.js";

export type ResolveComponent = (name: string) => Promise<{ default: unknown }>;

export interface BootRouterOptions {
	target: Element;
	adapter: PhotonAdapterHandle;
	resolveComponent: ResolveComponent;
	/** The page being hydrated: its version, and the deferred groups it owes. */
	page?: PhotonPageData;
}

const SUPPORTED_FRAMEWORKS: readonly ClientFramework[] = [
	"react",
	"vue",
	"svelte",
];

const PHOTON_HEADER = "x-photon";
const VERSION_HEADER = "x-photon-version";
const LOCATION_HEADER = "x-photon-location";

/**
 * The asset version of the page on screen, echoed on every navigation.
 *
 * The server compares it with the build it runs and answers a mismatch with a
 * 409, so a tab left open across a deploy reloads instead of fetching props for
 * JavaScript it no longer has. The router never sent it, so the server treated
 * every client as one that does not speak versioning and the check never fired.
 */
let currentVersion: string | undefined;

/** The page on screen, as last applied — what deferred props are merged into. */
let currentPage: PhotonPageData | undefined;

/** Who wants to know when the page on screen changes (`usePage`). */
const pageListeners = new Set<(page: PhotonPageData) => void>();

/** Make `page` the page on screen, and tell every subscriber. */
function setCurrentPage(page: PhotonPageData | undefined): void {
	currentPage = page;
	if (page === undefined) return;
	for (const listener of pageListeners) listener(page);
}

/**
 * The page about to be hydrated, known before the framework renders it — so a
 * component reading `usePage()` during hydration sees the page the server
 * rendered. `bootRouter` confirms it once the page is up.
 */
export function primeCurrentPage(page: PhotonPageData): void {
	currentPage = page;
}

/**
 * Be told whenever the page on screen changes — a navigation, a partial
 * reload, the back button, `remember` or `replace`. Returns the unsubscriber.
 * What the framework `usePage()` of `@c9up/photon/react`, `/vue` and
 * `/svelte` is built on.
 */
export function subscribeToPage(
	listener: (page: PhotonPageData) => void,
): () => void {
	pageListeners.add(listener);
	return () => {
		pageListeners.delete(listener);
	};
}

const PARTIAL_COMPONENT_HEADER = "x-photon-partial-component";
const PARTIAL_DATA_HEADER = "x-photon-partial-data";
const PARTIAL_EXCEPT_HEADER = "x-photon-partial-except";
const RESET_HEADER = "x-photon-reset";
const ERROR_BAG_HEADER = "x-photon-error-bag";
const EXCEPT_ONCE_HEADER = "x-photon-except-once-props";

/**
 * The `once` props the page on screen holds, as a header: the server skips
 * resolving them and the client puts its copy back ({@link withOnceProps}).
 */
function exceptOnceHeader(): Record<string, string> {
	return listHeader(
		EXCEPT_ONCE_HEADER,
		currentPage === undefined ? [] : heldOnceKeys(currentPage, Date.now()),
	);
}

/** `page` with the `once` values it was not sent restored from the one on screen. */
function withOnceProps(page: PhotonPageData): PhotonPageData {
	if (currentPage === undefined) return page;
	const restored = restoreOnceProps(page, currentPage);
	return restored === page ? page : { ...page, ...restored };
}

/**
 * Module-level "current options" slot. The click + popstate listeners are
 * installed exactly once per module load and read from this slot, so calling
 * `bootRouter` multiple times (e.g. across tests sharing one jsdom instance,
 * or after a teardown-and-rehydrate cycle) updates the active options without
 * accumulating listeners.
 */
let activeOptions: BootRouterOptions | undefined;
let listenersInstalled = false;

/**
 * Monotonic counter incremented at every navigate() call. The fetch + apply
 * pipeline reads its starting value and bails out if the global counter has
 * advanced (i.e. a newer click is in flight) before it tries to swap the DOM.
 * Prevents pages from arriving out-of-order on rapid double-clicks.
 */
let navigationSeq = 0;

/** Soft cap on `history.pushState` state size. Firefox enforces ~640KB hard. */
const STATE_SIZE_WARN_THRESHOLD = 100_000;

/**
 * Install document-level click + popstate listeners (once) and register the
 * supplied options as the active routing target. Subsequent calls update the
 * options slot without re-attaching listeners.
 */
export function bootRouter(options: BootRouterOptions): void {
	if (typeof document === "undefined" || typeof window === "undefined") {
		return;
	}

	activeOptions = options;
	currentVersion = options.page?.version;
	setCurrentPage(options.page);
	if (options.page !== undefined) loadDeferredProps(options.page, options);

	if (listenersInstalled) return;
	listenersInstalled = true;

	document.addEventListener("click", (event) => {
		if (!activeOptions) return;
		void handleClick(event, activeOptions);
	});

	window.addEventListener("popstate", (event) => {
		if (!activeOptions) return;
		void handlePopState(event, activeOptions);
	});

	window.addEventListener("pageshow", (event) => {
		void handlePageShow(event);
	});
}

async function handleClick(
	event: MouseEvent,
	options: BootRouterOptions,
): Promise<void> {
	if (!shouldInterceptClick(event)) return;

	const anchor = findAnchor(event.target);
	if (!anchor) return;

	const href = anchor.getAttribute("href");
	if (!href) return;

	const url = resolveUrl(href);
	if (!url) return;

	// Filter further AFTER the URL is parseable (matches checks the protocol +
	// origin, since `href` may have been a relative path).
	if (!isInterceptableUrl(url, anchor)) return;

	event.preventDefault();
	await navigate(url.pathname + url.search + url.hash, options);
}

function shouldInterceptClick(event: MouseEvent): boolean {
	if (event.defaultPrevented) return false;
	if (event.button !== 0) return false;
	if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
		return false;
	return true;
}

/** Walk up from `event.target` to the nearest enclosing `<a>` element. */
function findAnchor(target: EventTarget | null): HTMLAnchorElement | null {
	if (!(target instanceof Element)) return null;
	const anchor = target.closest("a");
	return anchor instanceof HTMLAnchorElement ? anchor : null;
}

function isInterceptableUrl(url: URL, anchor: HTMLAnchorElement): boolean {
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (typeof location !== "undefined" && url.origin !== location.origin)
		return false;

	const target = anchor.getAttribute("target");
	if (target && target !== "" && target !== "_self") return false;

	if (anchor.hasAttribute("download")) return false;
	if (anchor.dataset.photon === "external") return false;

	return true;
}

function resolveUrl(href: string): URL | null {
	try {
		// Use `document.baseURI` when present so relative anchors honor a
		// `<base href>` element (sub-path apps with a configured base). Fall
		// back to `location.href` for tests that run without a document.
		const base =
			typeof document !== "undefined" && typeof document.baseURI === "string"
				? document.baseURI
				: typeof location !== "undefined"
					? location.href
					: "http://localhost/";
		return new URL(href, base);
	} catch {
		return null;
	}
}

/**
 * Validate that a server-supplied URL string is safe to navigate to via
 * pushState/replaceState. Accepts: relative paths (start with `/`), or absolute
 * URLs that resolve to the current origin. Rejects: cross-origin absolute URLs,
 * protocol-relative URLs (`//evil.com/x`) that resolve cross-origin,
 * non-http(s) protocols.
 */
function isSafeNavigationUrl(url: string): boolean {
	if (typeof location === "undefined") return true; // SSR / non-browser; trust it
	try {
		const resolved = new URL(url, location.href);
		if (resolved.origin !== location.origin) return false;
		if (resolved.protocol !== "http:" && resolved.protocol !== "https:")
			return false;
		return true;
	} catch {
		return false;
	}
}

async function navigate(
	targetPath: string,
	options: BootRouterOptions,
	visitOptions: VisitOptions = {},
): Promise<void> {
	if (visitOptions.onBefore?.({ url: targetPath }) === false) return;
	const visit = describeVisit(
		targetPath,
		visitOptions,
		visitOptions.preserveState === true,
	);
	announceVisit("start", visit);
	let completed = false;
	try {
		completed = await fetchAndApply(targetPath, options, visitOptions);
	} finally {
		announceVisit("finish", visit);
		visitOptions.onFinish?.({ url: targetPath, completed });
	}
}

/** A navigation's request and swap; true once the new page is on screen. */
async function fetchAndApply(
	targetPath: string,
	options: BootRouterOptions,
	visitOptions: VisitOptions,
): Promise<boolean> {
	const ownSeq = ++navigationSeq;
	const controller = new AbortController();
	const method = visitOptions.method ?? "get";
	// A mutation that fails must not be replayed as a GET of its URL, which is
	// what the full-reload fallback would do: it stays on the page instead.
	const fallback = (url: string): void => {
		if (method === "get") fallbackToFullReload(url);
	};
	const data = visitOptions.data;
	const body =
		method === "get" || data === undefined
			? undefined
			: data instanceof FormData
				? data
				: visitOptions.forceFormData === true || hasFiles(data)
					? toFormData(data)
					: JSON.stringify(data);

	let response: Response;
	try {
		visitOptions.onStart?.({ url: targetPath });
		visitOptions.onCancelToken?.({ cancel: () => controller.abort() });
		response = await fetch(targetPath, {
			signal: controller.signal,
			method: method.toUpperCase(),
			...(body !== undefined ? { body } : {}),
			headers: {
				...visitOptions.headers,
				...(typeof body === "string"
					? { "content-type": "application/json" }
					: {}),
				...(method !== "get" ? xsrfHeader(targetPath) : {}),
				...exceptOnceHeader(),
				[PHOTON_HEADER]: "true",
				...(visitOptions.errorBag !== undefined && visitOptions.errorBag !== ""
					? { [ERROR_BAG_HEADER]: visitOptions.errorBag }
					: {}),
				...(currentVersion !== undefined
					? { [VERSION_HEADER]: currentVersion }
					: {}),
			},
			credentials: "same-origin",
		});
	} catch (err) {
		// Cancelled through its token: nothing to fall back to, the user asked.
		if (controller.signal.aborted) {
			visitOptions.onCancel?.();
			return false;
		}
		// Network failure — fall back to a real navigation rather than swallow.
		// Skip the fallback if a newer nav started in the meantime.
		if (ownSeq !== navigationSeq) return false;
		console.error(
			"[photon] SPA-nav fetch failed; falling back to full reload.",
			err,
		);
		fallback(targetPath);
		return false;
	}

	// Stale response — a newer nav has already started; drop on the floor.
	if (ownSeq !== navigationSeq) return false;

	// The server asking for a real navigation: a stale asset version, or an
	// explicit `location()` — which may leave the site, as upstream's may. It
	// used to be read as any other failure, so an external `location()` reloaded
	// the page the user was leaving instead of going where the server said.
	if (response.status === 409) {
		const target = response.headers.get(LOCATION_HEADER);
		fallbackToFullReload(
			target !== null && isHttpUrl(target) ? target : targetPath,
		);
		return false;
	}

	if (!response.ok) {
		console.error(
			`[photon] SPA-nav returned HTTP ${response.status}; falling back to full reload.`,
		);
		fallback(targetPath);
		return false;
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("application/json")) {
		// Server returned a full SSR page (or something else). Full reload preserves
		// the user's intent without trying to interpret HTML as page-data.
		fallback(targetPath);
		return false;
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (err) {
		console.error(
			"[photon] SPA-nav JSON parse failed; falling back to full reload.",
			err,
		);
		fallback(targetPath);
		return false;
	}

	// Re-check after every async boundary — `response.json()` may have yielded
	// to the event loop long enough for a fresher click to overtake.
	if (ownSeq !== navigationSeq) return false;

	const parsed = parsePageData(payload);
	if (!parsed) {
		fallback(targetPath);
		return false;
	}
	const newPageData = withOnceProps(parsed);

	visitOptions.onBeforeUpdate?.(newPageData);
	await applyPageData(
		newPageData,
		options,
		/* fromHistory */ false,
		ownSeq,
		visitOptions.replace === true,
	);
	if (ownSeq !== navigationSeq || currentPage === undefined) return false;
	const errors = errorsOf(currentPage, visitOptions.errorBag);
	if (Object.keys(errors).length > 0) {
		visitOptions.onError?.(errors);
		announceErrors(errors);
	} else {
		visitOptions.onSuccess?.(currentPage);
		announceSuccess(currentPage);
	}
	announceFlash(newPageData.flash);
	return true;
}

async function applyPageData(
	pageData: PhotonPageData,
	options: BootRouterOptions,
	fromHistory: boolean,
	expectedSeq?: number,
	replace = false,
): Promise<void> {
	// Reject server-supplied URLs that would navigate cross-origin or to a
	// non-http(s) scheme. Without this guard a buggy/malicious SSR could poison
	// the address bar via pushState (browsers reject true cross-origin pushState
	// with SecurityError, but protocol-relative `//evil.com/x` and javascript:
	// URLs slip through differently across engines).
	if (!isSafeNavigationUrl(pageData.url)) {
		console.error(
			`[photon] page-data.url '${pageData.url}' is not a safe same-origin URL; navigation aborted.`,
		);
		// Do NOT fall back to `location.href = pageData.url` — that would
		// perform exactly the cross-origin / non-http(s) navigation this
		// guard exists to block (a malformed or hostile SSR payload could
		// otherwise force an external redirect or a `javascript:` URL).
		// Abort instead: nothing has been applied yet, so the current page
		// stays intact.
		return;
	}

	let mod: { default: unknown };
	try {
		mod = await options.resolveComponent(pageData.component);
	} catch (err) {
		console.error(
			`[photon] resolveComponent('${pageData.component}') threw; full reload.`,
			err,
		);
		fallbackToFullReload(pageData.url);
		return;
	}

	// Last stale-check before mutating the DOM — bail if a newer navigation
	// arrived while resolveComponent was awaiting.
	if (expectedSeq !== undefined && expectedSeq !== navigationSeq) return;

	if (pageData.version !== undefined) currentVersion = pageData.version;
	setCurrentPage(pageData);

	try {
		options.adapter.update(mod.default, pageData.props);
	} catch (err) {
		// Adapter render failure leaves the DOM in an unknown state. Full reload
		// keeps URL bar and DOM consistent — anything else lies to the user.
		console.error(
			"[photon] adapter.update threw; falling back to full reload.",
			err,
		);
		fallbackToFullReload(pageData.url);
		return;
	}

	// Sync `<head>` to the destination page — title, meta, canonical, OG/
	// Twitter cards. The initial SSR HTML wrote these from server-resolved
	// `@Meta` / `ctx.photon.meta()` / `defaultMeta`; without this call the
	// SPA navigation would stick on the initial-load values.
	try {
		applyMetaToDom(pageData.meta);
	} catch (err) {
		// Head mutation failures are non-fatal — the page itself rendered.
		console.warn("[photon] applyMetaToDom threw; head may be stale.", err);
	}

	if (
		!fromHistory &&
		typeof history !== "undefined" &&
		typeof history.pushState === "function"
	) {
		warnOnLargeState(pageData);
		// If the URL hasn't changed, replace the history entry rather than
		// stack a duplicate. Repeated clicks on the same link otherwise inflate
		// history with redundant entries (back-button UX degrades).
		const sameUrl =
			replace ||
			(typeof location !== "undefined" &&
				resolvedSameUrl(pageData.url, location.href));
		// Encrypted when the page asks for it — which takes a turn of the event
		// loop, so a newer navigation may have pushed its own entry meanwhile.
		const state = await toHistoryState(pageData);
		if (expectedSeq !== undefined && expectedSeq !== navigationSeq) return;
		try {
			if (sameUrl && typeof history.replaceState === "function") {
				history.replaceState(state, "", pageData.url);
			} else {
				history.pushState(state, "", pageData.url);
			}
		} catch (err) {
			// Same-origin pushState should never throw under normal use; log and continue.
			console.error(
				"[photon] history.pushState failed; navigation will not appear in history.",
				err,
			);
		}
	}

	loadDeferredProps(pageData, options);
}

/**
 * Ask for every deferred group the page still lacks, one partial reload per
 * group, so a slow group does not hold the others back.
 *
 * `defer()` sends the NAME of a prop and not its value; the value only ever
 * arrives through this request. The router never made it, so a deferred panel
 * stayed empty forever. Only the props not already held are asked for: a page
 * restored from history may carry some groups already.
 */
function loadDeferredProps(
	page: PhotonPageData,
	options: BootRouterOptions,
): void {
	const seq = navigationSeq;
	for (const props of Object.values(page.deferredProps ?? {})) {
		const missing = props.filter((name) => !(name in page.props));
		if (missing.length > 0) {
			void fetchPartial(
				page,
				page.url,
				{ only: missing, preserveErrors: true, preserveUrl: true },
				options,
				seq,
				{ background: true },
			);
		}
	}
}

/**
 * The visit callbacks, under `@inertiajs/core`'s names — the subset a GET visit
 * reaches. `onBefore` returning false cancels the visit.
 */
export interface VisitCallbacks {
	onBefore?(visit: { url: string }): boolean | undefined;
	/** Receives the handle that cancels the visit while it is in flight. */
	onCancelToken?(token: { cancel(): void }): void;
	/** The visit was cancelled through its token. */
	onCancel?(): void;
	/** The request is about to be sent. */
	onStart?(visit: { url: string }): void;
	/** The answer is in and about to replace what is on screen. */
	onBeforeUpdate?(page: PhotonPageData): void;
	onSuccess?(page: PhotonPageData): void;
	/**
	 * The page came back with validation errors (scoped to `errorBag` when
	 * given): called instead of `onSuccess`.
	 */
	onError?(errors: Record<string, unknown>): void;
	/** Always last: `completed` is false when the visit was dropped or failed. */
	onFinish?(visit: { url: string; completed: boolean }): void;
}

/** Which props a partial reload asks for, drops, or wants replaced whole. */
export interface PartialRequest extends VisitCallbacks {
	/** Only these props are resolved; the rest keep their current value. */
	only?: string[];
	/** Every prop but these is resolved. */
	except?: string[];
	/** These are replaced rather than combined with what the client holds. */
	reset?: string[];
	/** Extra request headers. */
	headers?: Record<string, string>;
	/** Scope the validation errors to one form (`x-photon-error-bag`). */
	errorBag?: string;
	/** Query parameters added to the URL (a GET visit sends its data there). */
	data?: RequestPayload;
	/** Keep the page's validation errors instead of taking the server's. */
	preserveErrors?: boolean;
	/** Keep the address bar on the current URL whatever URL answered. */
	preserveUrl?: boolean;
}

/** The HTTP methods a visit can use. */
export type Method = "get" | "post" | "put" | "patch" | "delete";

/** What a visit sends: fields, or a ready `FormData`. */
export type RequestPayload = Record<string, unknown> | FormData;

/**
 * `path` with `data` merged into its query string, nested keys as
 * `a[b]=…` and arrays as `a[]=…` — `mergeDataIntoQueryString` in
 * `@inertiajs/core`, for a GET visit.
 */
export function withQuery(
	path: string,
	data: RequestPayload | undefined,
): string {
	if (data === undefined || data instanceof FormData) return path;
	if (Object.keys(data).length === 0) return path;
	const url = new URL(path, "http://photon.invalid");
	const pairs: Array<[string, string]> = [];
	const build = (value: unknown, prefix: string): void => {
		if (value === undefined) return;
		if (value === null) pairs.push([prefix, ""]);
		else if (Array.isArray(value)) {
			for (const item of value) build(item, `${prefix}[]`);
		} else if (typeof value === "object") {
			for (const [key, inner] of Object.entries(value)) {
				build(inner, `${prefix}[${key}]`);
			}
		} else pairs.push([prefix, String(value)]);
	};
	for (const [key, value] of Object.entries(data)) {
		url.searchParams.delete(key);
		build(value, key);
	}
	for (const [key, value] of pairs) url.searchParams.append(key, value);
	// An absolute URL keeps its origin; a path stays a path.
	return /^[a-z][a-z\d+\-.]*:/i.test(path)
		? url.href
		: url.pathname + url.search + url.hash;
}

/** Whether `value` holds a file anywhere — which makes a body multipart. */
function hasFiles(value: unknown): boolean {
	if (value instanceof Blob) return true;
	if (typeof FileList !== "undefined" && value instanceof FileList) {
		return value.length > 0;
	}
	if (value instanceof FormData) {
		return [...value.values()].some((item) => hasFiles(item));
	}
	if (typeof value === "object" && value !== null) {
		return Object.values(value).some((item) => hasFiles(item));
	}
	return false;
}

/**
 * `data` as a multipart form — `objectToFormData` in `@inertiajs/core`:
 * nested keys as `a[b]`, arrays as `a[]`, booleans as 1/0, dates as ISO.
 */
function toFormData(data: Record<string, unknown>): FormData {
	const form = new FormData();
	const append = (key: string, value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) append(`${key}[]`, item);
		} else if (value instanceof Date) form.append(key, value.toISOString());
		else if (value instanceof File) form.append(key, value, value.name);
		else if (value instanceof Blob) form.append(key, value);
		else if (typeof value === "boolean") form.append(key, value ? "1" : "0");
		else if (typeof value === "string") form.append(key, value);
		else if (typeof value === "number") form.append(key, String(value));
		else if (value === null || value === undefined) form.append(key, "");
		else if (typeof FileList !== "undefined" && value instanceof FileList) {
			for (const file of value) form.append(`${key}[]`, file, file.name);
		} else if (typeof value === "object") {
			for (const [inner, item] of Object.entries(value)) {
				append(`${key}[${inner}]`, item);
			}
		}
	};
	for (const [key, value] of Object.entries(data)) append(key, value);
	return form;
}

/**
 * The CSRF token for a same-origin request: the `XSRF-TOKEN` cookie the server
 * seeds, sent back as `X-XSRF-TOKEN` — what Inertia's HTTP client does, and
 * what Ream's CSRF middleware reads. Never to another origin.
 */
function xsrfHeader(url: string): Record<string, string> {
	if (typeof document === "undefined") return {};
	try {
		if (new URL(url, location.href).origin !== location.origin) return {};
	} catch {
		return {};
	}
	for (const part of document.cookie.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === "XSRF-TOKEN") {
			return { "X-XSRF-TOKEN": decodeURIComponent(rest.join("=")) };
		}
	}
	return {};
}

/**
 * The validation errors on `page`, scoped to `errorBag` when one was used —
 * non-empty means the visit failed validation.
 */
function errorsOf(
	page: PhotonPageData,
	errorBag: string | undefined,
): Record<string, unknown> {
	const errors: unknown = page.props.errors;
	if (typeof errors !== "object" || errors === null) return {};
	const scoped: unknown =
		errorBag !== undefined && errorBag !== ""
			? Reflect.get(errors, errorBag)
			: errors;
	return typeof scoped === "object" && scoped !== null ? { ...scoped } : {};
}

/** Whether `request` names props at all — what makes a visit a partial one. */
function isPartial(request: PartialRequest): boolean {
	return (
		(request.only?.length ?? 0) > 0 ||
		(request.except?.length ?? 0) > 0 ||
		(request.reset?.length ?? 0) > 0
	);
}

/**
 * Reload part of `page` and merge the answer into what is on screen, without
 * remounting it. Resolves true once the props are applied, false when the
 * request was dropped: a navigation since, a failure, or another page answering.
 *
 * `background` is for requests the user did not ask for — a deferred group —
 * whose flash must not be announced a second time.
 */
async function fetchPartial(
	page: PhotonPageData,
	url: string,
	request: PartialRequest,
	options: BootRouterOptions,
	seq: number,
	flags: { background: boolean },
): Promise<boolean> {
	if (request.onBefore?.({ url }) === false) return false;
	const visit = describeVisit(url, request, true);
	announceVisit("start", visit);
	let completed = false;
	try {
		completed = await applyPartial(page, url, request, options, seq, flags);
		return completed;
	} finally {
		announceVisit("finish", visit);
		request.onFinish?.({ url, completed });
	}
}

async function applyPartial(
	page: PhotonPageData,
	url: string,
	request: PartialRequest,
	options: BootRouterOptions,
	seq: number,
	{ background }: { background: boolean },
): Promise<boolean> {
	// Still the page this request belongs to: no navigation since, same component.
	const stillCurrent = (): boolean =>
		seq === navigationSeq && currentPage?.component === page.component;
	const what = request.only?.join(", ") ?? "props";

	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				...request.headers,
				...exceptOnceHeader(),
				[PHOTON_HEADER]: "true",
				[PARTIAL_COMPONENT_HEADER]: page.component,
				// A reset prop is asked for too: it is resolved again, then
				// replaces what the client holds instead of joining it.
				...listHeader(PARTIAL_DATA_HEADER, [
					...(request.only ?? []),
					...(request.reset ?? []),
				]),
				...listHeader(PARTIAL_EXCEPT_HEADER, request.except),
				...listHeader(RESET_HEADER, request.reset),
				...(request.errorBag !== undefined && request.errorBag !== ""
					? { [ERROR_BAG_HEADER]: request.errorBag }
					: {}),
				...(currentVersion !== undefined
					? { [VERSION_HEADER]: currentVersion }
					: {}),
			},
			credentials: "same-origin",
		});
	} catch (err) {
		console.error(`[photon] partial reload of ${what} failed.`, err);
		return false;
	}
	if (!stillCurrent()) return false;
	if (response.status === 409) {
		const target = response.headers.get(LOCATION_HEADER);
		fallbackToFullReload(target !== null && isHttpUrl(target) ? target : url);
		return false;
	}
	const contentType = response.headers.get("content-type") ?? "";
	if (!response.ok || !contentType.toLowerCase().includes("application/json")) {
		// One request failing leaves the page and the other requests as they are.
		console.error(
			`[photon] partial reload of ${what} returned HTTP ${response.status}.`,
		);
		return false;
	}
	const parsed = parsePageData(await response.json().catch(() => null));
	if (!parsed || parsed.component !== page.component || !stillCurrent()) {
		return false;
	}
	let mod: { default: unknown };
	try {
		mod = await options.resolveComponent(page.component);
	} catch (err) {
		console.error(
			"[photon] partial reload could not re-resolve the page.",
			err,
		);
		return false;
	}
	// Read only now: requests arrive concurrently, and one read before the await
	// above would merge into a page another request has since replaced.
	const current = currentPage;
	if (!stillCurrent() || current === undefined) return false;
	const loaded = withOnceProps(parsed);

	// The answer's props join what is on screen; the props it did not carry
	// keep their current value, and the labelled ones are combined with it.
	const props = mergePartialProps(current.props, loaded.props, loaded, {
		only: request.only,
		except: request.except,
	});
	if (request.preserveErrors === true && "errors" in current.props) {
		props.errors = current.props.errors;
	}
	const next: PhotonPageData = {
		...current,
		props,
		// The address the answer came from, unless the caller keeps the bar as it
		// is (an infinite scroll asking for `?page=3` behind the user's back).
		url:
			request.preserveUrl !== true && isSafeNavigationUrl(loaded.url)
				? loaded.url
				: current.url,
		// A scroll prop's cursor moves with each answer; the others keep theirs.
		...(current.scrollProps !== undefined || loaded.scrollProps !== undefined
			? { scrollProps: { ...current.scrollProps, ...loaded.scrollProps } }
			: {}),
		// A partial answer states the terms of the once props it carried; the
		// others keep theirs.
		...(current.onceProps !== undefined || loaded.onceProps !== undefined
			? { onceProps: { ...current.onceProps, ...loaded.onceProps } }
			: {}),
		...(loaded.deferredProps !== undefined
			? { deferredProps: loaded.deferredProps }
			: {}),
		// A prop asked for again is no longer rescued unless the answer says so.
		rescuedProps: mergeRescuedProps(
			current.rescuedProps,
			loaded.rescuedProps,
			request,
		),
	};
	request.onBeforeUpdate?.(next);
	setCurrentPage(next);
	try {
		options.adapter.update(mod.default, next.props);
	} catch (err) {
		console.error("[photon] adapter.update threw on a partial reload.", err);
		return false;
	}
	// History gets the page as it now is, so back/forward does not ask again.
	const state = await toHistoryState(next);
	if (stillCurrent() && currentPage === next) {
		try {
			history.replaceState(state, "", next.url);
		} catch {
			// Restricted history: the props are on screen, only the cache is stale.
		}
	}
	request.onSuccess?.(next);
	announceSuccess(next);
	if (!background) announceFlash(loaded.flash);
	// A reload can announce deferred groups of its own.
	if (loaded.deferredProps !== undefined && stillCurrent()) {
		loadDeferredProps(next, options);
	}
	return true;
}

/**
 * `photon:success` on `document` once a visit's page is on screen — the event
 * `@inertiajs/core` fires as `inertia:success`, same `detail: { page }`.
 */
function announceSuccess(page: PhotonPageData): void {
	if (typeof document === "undefined") return;
	document.dispatchEvent(
		new CustomEvent("photon:success", { detail: { page } }),
	);
}

/** A visit as the router events describe it. */
export interface Visit {
	url: string;
	only: string[];
	except: string[];
	reset: string[];
	/** True for a visit that stays on the page: a partial or plain reload. */
	preserveState: boolean;
}

/** A verb's target as a URL: the verb itself decides the method. */
function urlOf(target: string | RouteTarget): string {
	return typeof target === "string" ? target : resolveTarget(target).url;
}

/** The router events a page can listen to, with what their `detail` carries. */
export interface RouterEvents {
	error: { errors: Record<string, unknown> };
	start: { visit: Visit };
	finish: { visit: Visit };
	success: { page: PhotonPageData };
	flash: { flash: object };
}

/** `photon:error` on `document`, as `inertia:error` — a visit came back with errors. */
function announceErrors(errors: Record<string, unknown>): void {
	if (typeof document === "undefined") return;
	document.dispatchEvent(
		new CustomEvent("photon:error", { detail: { errors } }),
	);
}

function announceVisit(type: "start" | "finish", visit: Visit): void {
	if (typeof document === "undefined") return;
	document.dispatchEvent(
		new CustomEvent(`photon:${type}`, { detail: { visit } }),
	);
}

function describeVisit(
	url: string,
	request: PartialRequest,
	preserveState: boolean,
): Visit {
	return {
		url,
		only: request.only ?? [],
		except: request.except ?? [],
		reset: request.reset ?? [],
		preserveState,
	};
}

/** Writes to `history.state` from `remember`, one after the other. */
let rememberQueue: Promise<void> = Promise.resolve();

/** Store the page on screen in its history entry again, as it now is. */
function rewriteHistoryEntry(): void {
	rememberQueue = rememberQueue.then(async () => {
		const page = currentPage;
		if (page === undefined || typeof history === "undefined") return;
		const state = await toHistoryState(page);
		if (currentPage !== page) return;
		try {
			history.replaceState(state, "", page.url);
		} catch {
			// Restricted history: the state lives on in memory only.
		}
	});
}

/** The page on screen, as the router last applied it. */
export function getCurrentPage(): PhotonPageData | undefined {
	return currentPage;
}

/**
 * A partial reload of the page on screen, true when its answer was applied —
 * for helpers that must know, as `router.reload()` only settles.
 */
export async function reloadCurrentPage(
	request: PartialRequest,
): Promise<boolean> {
	const page = currentPage;
	const options = activeOptions;
	if (page === undefined || options === undefined) return false;
	return fetchPartial(
		page,
		withQuery(page.url, request.data),
		{
			...request,
			headers: { ...request.headers, "cache-control": "no-cache" },
		},
		options,
		navigationSeq,
		{ background: false },
	);
}

/**
 * Tell the page about a flash bag, as a `photon:flash` event on `document` —
 * `inertia:flash` in `@inertiajs/core`, same `detail: { flash }`. Only a
 * non-empty bag is announced. It is never stored in history, so going back does
 * not announce it again.
 */
export function announceFlash(flash: unknown): void {
	if (typeof document === "undefined") return;
	if (typeof flash !== "object" || flash === null) return;
	if (Object.keys(flash).length === 0) return;
	document.dispatchEvent(
		new CustomEvent("photon:flash", { detail: { flash } }),
	);
}

/**
 * The props whose deferred resolver failed, after a partial answer —
 * `mergeRescuedProps` in `@inertiajs/core`: a prop this request asked for
 * drops out, and the answer's own rescued props join.
 */
function mergeRescuedProps(
	current: string[] | undefined,
	incoming: string[] | undefined,
	request: PartialRequest,
): string[] {
	const visit = describeVisit("", request, true);
	const kept = (current ?? []).filter(
		(prop) => !partialReloadRequestsProp(visit, prop),
	);
	return [...new Set([...kept, ...(incoming ?? [])])];
}

/** `path` is `candidate` or lies under it. */
function isPathOrSubPath(path: string, candidate: string): boolean {
	return path === candidate || path.startsWith(`${candidate}.`);
}

/**
 * Whether a partial `visit` resolves `prop` — `partialReloadRequestsProp` in
 * `@inertiajs/core`. A visit naming no props requests none of them partially.
 */
export function partialReloadRequestsProp(visit: Visit, prop: string): boolean {
	const { only, except } = visit;
	if (only.length === 0 && except.length === 0) return false;
	if (
		only.length > 0 &&
		!only.some((candidate) => isPathOrSubPath(prop, candidate))
	) {
		return false;
	}
	if (
		except.length > 0 &&
		except.some((candidate) => isPathOrSubPath(prop, candidate))
	) {
		return false;
	}
	return true;
}

/** A comma-separated list header, or nothing when the list is absent. */
function listHeader(
	name: string,
	values: string[] | undefined,
): Record<string, string> {
	return values !== undefined && values.length > 0
		? { [name]: values.join(",") }
		: {};
}

/**
 * Options for {@link router.visit}: the subset of Inertia's visit options that
 * a GET navigation uses, under the same names.
 */
export interface VisitOptions extends PartialRequest {
	/** The HTTP method. Default `get`. */
	method?: Method;
	/** Send `data` as multipart even without a file in it. */
	forceFormData?: boolean;
	/** Replace the current history entry instead of adding one. */
	replace?: boolean;
	/** Stay on the page: reported on the visit, as `router.reload()` sets it. */
	preserveState?: boolean;
}

/**
 * Navigate and reload from code, the shape of `@inertiajs/core`'s `router`.
 *
 * - `visit(url)` fetches the page and swaps it in; with `only` / `except` /
 *   `reset` it is a partial reload of the page on screen, merged without
 *   remounting it. A URL on another origin, or a call before the page is
 *   hydrated, is a full navigation.
 * - `reload()` is `visit()` of the current URL, sent with
 *   `Cache-Control: no-cache` so no cache answers it.
 *
 * One deliberate difference: both return a promise that settles once the page
 * is applied (or the visit dropped), where Inertia's return nothing and report
 * through callbacks. Code written for Inertia, which ignores the return value,
 * works unchanged.
 */
export const router = {
	/**
	 * Visit a URL, a named route (`{ route, routeParams, qs }`, as
	 * `@adonisjs/inertia`'s `useRouter().visit` takes it — the route's own
	 * method unless `method` is given) or `{ href }`.
	 */
	async visit(
		target: string | RouteTarget,
		options: VisitOptions = {},
	): Promise<void> {
		if (typeof target !== "string") {
			const resolved = resolveTarget(target);
			const method = resolved.method ?? options.method;
			return router.visit(resolved.url, {
				...options,
				...(method !== undefined ? { method } : {}),
			});
		}
		const url = target;
		const visitOptions = options;
		const resolved = resolveUrl(url);
		if (
			activeOptions === undefined ||
			resolved === null ||
			typeof location === "undefined" ||
			resolved.origin !== location.origin ||
			(resolved.protocol !== "http:" && resolved.protocol !== "https:")
		) {
			if (resolved !== null && isHttpUrl(resolved.href)) {
				fallbackToFullReload(resolved.href);
			}
			return;
		}
		const method = visitOptions.method ?? "get";
		// A GET sends its data in the query; any other method in its body.
		const path = withQuery(
			resolved.pathname + resolved.search + resolved.hash,
			method === "get" ? visitOptions.data : undefined,
		);
		const page = currentPage;
		if (method === "get" && isPartial(visitOptions) && page !== undefined) {
			await fetchPartial(
				page,
				path,
				visitOptions,
				activeOptions,
				navigationSeq,
				{
					background: false,
				},
			);
			return;
		}
		await navigate(path, activeOptions, visitOptions);
	},

	async reload(request: PartialRequest = {}): Promise<void> {
		const page = currentPage;
		if (page === undefined) return;
		await router.visit(page.url, {
			...request,
			replace: true,
			preserveState: true,
			headers: { ...request.headers, "cache-control": "no-cache" },
		});
	},

	/** `visit(url, { method: "get", data })`. */
	get(
		target: string | RouteTarget,
		data: RequestPayload = {},
		options: VisitOptions = {},
	) {
		const url = urlOf(target);
		return router.visit(url, { ...options, method: "get", data });
	},

	/** A POST visit; state is kept on the page, as Inertia's `router.post`. */
	post(
		target: string | RouteTarget,
		data: RequestPayload = {},
		options: VisitOptions = {},
	) {
		const url = urlOf(target);
		return router.visit(url, {
			preserveState: true,
			...options,
			method: "post",
			data,
		});
	},

	put(
		target: string | RouteTarget,
		data: RequestPayload = {},
		options: VisitOptions = {},
	) {
		const url = urlOf(target);
		return router.visit(url, {
			preserveState: true,
			...options,
			method: "put",
			data,
		});
	},

	patch(
		target: string | RouteTarget,
		data: RequestPayload = {},
		options: VisitOptions = {},
	) {
		const url = urlOf(target);
		return router.visit(url, {
			preserveState: true,
			...options,
			method: "patch",
			data,
		});
	},

	delete(target: string | RouteTarget, options: VisitOptions = {}) {
		const url = urlOf(target);
		return router.visit(url, {
			preserveState: true,
			...options,
			method: "delete",
		});
	},

	/**
	 * Listen to a router event; returns the function that stops listening.
	 * `router.on('success', …)` hears every visit whose page reached the screen.
	 */
	on<K extends keyof RouterEvents>(
		type: K,
		callback: (event: CustomEvent<RouterEvents[K]>) => void,
	): () => void {
		if (typeof document === "undefined") return () => {};
		const listener = (event: Event): void => {
			if (event instanceof CustomEvent) callback(event);
		};
		document.addEventListener(`photon:${type}`, listener);
		return () => document.removeEventListener(`photon:${type}`, listener);
	},

	/**
	 * Keep `data` under `key` in the page's history entry, so it is there again
	 * when the user comes back to it — by the back button or by reloading the
	 * tab. Encrypted with the rest of the page when the page asks for it.
	 */
	remember(data: unknown, key = "default"): void {
		const page = currentPage;
		if (page === undefined) return;
		setCurrentPage({
			...page,
			rememberedState: { ...page.rememberedState, [key]: data },
		});
		rewriteHistoryEntry();
	},

	/** What {@link router.remember} kept under `key` for the page on screen. */
	restore(key = "default"): unknown {
		return currentPage?.rememberedState?.[key];
	},

	/**
	 * Change the page on screen without a request — the `url` part of
	 * Inertia's client-side `router.replace()`. Refused for a URL on another
	 * origin, which `history.replaceState` could not show anyway.
	 */
	replace({ url }: { url: string }): void {
		const page = currentPage;
		if (page === undefined || !isSafeNavigationUrl(url)) return;
		setCurrentPage({ ...page, url });
		rewriteHistoryEntry();
	},
};

function resolvedSameUrl(target: string, current: string): boolean {
	try {
		const a = new URL(target, current);
		const b = new URL(current);
		return (
			a.origin === b.origin &&
			a.pathname === b.pathname &&
			a.search === b.search &&
			a.hash === b.hash
		);
	} catch {
		return false;
	}
}

function warnOnLargeState(pageData: PhotonPageData): void {
	try {
		const size = JSON.stringify(pageData).length;
		if (size > STATE_SIZE_WARN_THRESHOLD) {
			console.warn(
				`[photon] history state is ${size} bytes — Firefox enforces a ~640KB cap. ` +
					"Consider trimming props or storing large payloads outside page-data.",
			);
		}
	} catch {
		// JSON.stringify can throw on circular refs; not our concern here, the
		// pushState below will surface the failure.
	}
}

async function handlePopState(
	event: PopStateEvent,
	options: BootRouterOptions,
): Promise<void> {
	const ownSeq = ++navigationSeq;
	if (!isPhotonState(event.state)) {
		// No state (e.g. user navigated to a non-Photon URL). Full reload restores
		// browser intent without trying to interpret a non-Photon page in-flight.
		reloadFromServer();
		return;
	}

	// Unreadable — withheld, or encrypted under a key `clearHistory` deleted —
	// means the server decides what this URL shows now. That is the point of
	// clearing: the back button after logout gets a login page, not the
	// previous session's props.
	const pageData = parsePageData(await readHistoryState(event.state));
	if (ownSeq !== navigationSeq) return;
	if (!pageData || isStaleVersion(pageData)) {
		reloadFromServer();
		return;
	}

	await applyPageData(pageData, options, /* fromHistory */ true, ownSeq);
}

/**
 * A page restored from the back-forward cache comes back as it was, DOM and
 * all, without a `popstate`. If its history entry can no longer be read — the
 * key was cleared at logout — it must not stay on screen either.
 */
async function handlePageShow(event: PageTransitionEvent): Promise<void> {
	if (!event.persisted || typeof history === "undefined") return;
	const state: unknown = history.state;
	if (!isPhotonState(state)) return;
	if ((await readHistoryState(state)) === undefined) reloadFromServer();
}

/** A page stored under an asset version the server no longer runs. */
function isStaleVersion(pageData: PhotonPageData): boolean {
	return (
		pageData.version !== undefined &&
		currentVersion !== undefined &&
		pageData.version !== currentVersion
	);
}

function reloadFromServer(): void {
	if (typeof location !== "undefined") location.reload();
}

function parsePageData(value: unknown): PhotonPageData | null {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return null;
	const obj = value as Record<string, unknown>;
	if (typeof obj.component !== "string" || obj.component.length === 0)
		return null;
	if (typeof obj.url !== "string") return null;
	if (
		typeof obj.framework !== "string" ||
		!SUPPORTED_FRAMEWORKS.includes(obj.framework as ClientFramework)
	) {
		return null;
	}
	if (
		typeof obj.props !== "object" ||
		obj.props === null ||
		Array.isArray(obj.props)
	)
		return null;
	const out: PhotonPageData = {
		component: obj.component,
		props: obj.props as Record<string, unknown>,
		url: obj.url,
		framework: obj.framework as ClientFramework,
	};
	const meta = obj.meta;
	if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
		out.meta = meta as MetaTags;
	}
	if (typeof obj.version === "string") out.version = obj.version;
	if (obj.clearHistory === true) out.clearHistory = true;
	if (obj.encryptHistory === true) out.encryptHistory = true;
	const deferredProps = readDeferredProps(obj.deferredProps);
	if (deferredProps !== undefined) out.deferredProps = deferredProps;
	for (const label of MERGE_LABELS) {
		const names = readStringList(obj[label]);
		if (names !== undefined) out[label] = names;
	}
	const rescued = readStringList(obj.rescuedProps);
	if (rescued !== undefined) out.rescuedProps = rescued;
	const onceProps = readOnceProps(obj.onceProps);
	if (onceProps !== undefined) out.onceProps = onceProps;
	const scrollProps = readScrollProps(obj.scrollProps);
	if (scrollProps !== undefined) out.scrollProps = scrollProps;
	const remembered = obj.rememberedState;
	if (
		typeof remembered === "object" &&
		remembered !== null &&
		!Array.isArray(remembered)
	) {
		out.rememberedState = { ...remembered };
	}
	if (typeof obj.flash === "object" && obj.flash !== null)
		out.flash = obj.flash;
	return out;
}

/** A page cursor: a page number, a cursor string, or null at either end. */
function isPageRef(value: unknown): value is number | string | null {
	return (
		value === null || typeof value === "number" || typeof value === "string"
	);
}

/** A page's `scrollProps`, when every entry has the shape the server sends. */
export function readScrollProps(
	value: unknown,
): Record<string, ScrollPropMeta> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const out: Record<string, ScrollPropMeta> = {};
	for (const [key, meta] of Object.entries(value)) {
		if (typeof meta !== "object" || meta === null) return undefined;
		const pageName: unknown = Reflect.get(meta, "pageName");
		const currentPage: unknown = Reflect.get(meta, "currentPage");
		const nextPage: unknown = Reflect.get(meta, "nextPage");
		const previousPage: unknown = Reflect.get(meta, "previousPage");
		const reset: unknown = Reflect.get(meta, "reset");
		if (
			typeof pageName !== "string" ||
			!isPageRef(currentPage) ||
			!isPageRef(nextPage) ||
			!isPageRef(previousPage)
		) {
			return undefined;
		}
		out[key] = {
			pageName,
			currentPage,
			nextPage,
			previousPage,
			reset: reset === true,
		};
	}
	return out;
}

/** A page's `onceProps`, when every entry has the shape the server sends. */
export function readOnceProps(
	value: unknown,
): Record<string, OncePropMeta> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const out: Record<string, OncePropMeta> = {};
	for (const [key, meta] of Object.entries(value)) {
		if (typeof meta !== "object" || meta === null) return undefined;
		const prop: unknown = Reflect.get(meta, "prop");
		const expiresAt: unknown = Reflect.get(meta, "expiresAt");
		if (
			typeof prop !== "string" ||
			(expiresAt !== null && typeof expiresAt !== "number")
		) {
			return undefined;
		}
		out[key] = { prop, expiresAt };
	}
	return out;
}

/** The page fields that say how a partial reload's props combine. */
export const MERGE_LABELS = [
	"mergeProps",
	"prependProps",
	"deepMergeProps",
	"matchPropsOn",
] as const;

/** A list of strings, or undefined for anything else. */
function readStringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? value
		: undefined;
}

/**
 * A page's `deferredProps`, when it is the shape the server sends: groups of
 * prop names. Anything else is dropped rather than half-trusted.
 */
export function readDeferredProps(
	value: unknown,
): Record<string, string[]> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const groups: Record<string, string[]> = {};
	for (const [group, names] of Object.entries(value)) {
		if (
			!Array.isArray(names) ||
			!names.every((name) => typeof name === "string")
		) {
			return undefined;
		}
		groups[group] = names;
	}
	return groups;
}

/** A relative URL, or an absolute one over http(s) — never `javascript:`. */
function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value, location.href);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function fallbackToFullReload(url: string): void {
	if (typeof location === "undefined") return;
	try {
		location.href = url;
	} catch {
		// Unreachable in real browsers; jsdom's restricted `location` setter may throw.
	}
}
