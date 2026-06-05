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
import type { ClientFramework, PhotonPageData } from "./hydrate.js";

export type ResolveComponent = (name: string) => Promise<{ default: unknown }>;

export interface BootRouterOptions {
	target: Element;
	adapter: PhotonAdapterHandle;
	resolveComponent: ResolveComponent;
}

const SUPPORTED_FRAMEWORKS: readonly ClientFramework[] = [
	"react",
	"vue",
	"svelte",
];

const PHOTON_HEADER = "x-photon";

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
): Promise<void> {
	const ownSeq = ++navigationSeq;

	let response: Response;
	try {
		response = await fetch(targetPath, {
			headers: { [PHOTON_HEADER]: "true" },
			credentials: "same-origin",
		});
	} catch (err) {
		// Network failure — fall back to a real navigation rather than swallow.
		// Skip the fallback if a newer nav started in the meantime.
		if (ownSeq !== navigationSeq) return;
		console.error(
			"[photon] SPA-nav fetch failed; falling back to full reload.",
			err,
		);
		fallbackToFullReload(targetPath);
		return;
	}

	// Stale response — a newer nav has already started; drop on the floor.
	if (ownSeq !== navigationSeq) return;

	if (!response.ok) {
		console.error(
			`[photon] SPA-nav returned HTTP ${response.status}; falling back to full reload.`,
		);
		fallbackToFullReload(targetPath);
		return;
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("application/json")) {
		// Server returned a full SSR page (or something else). Full reload preserves
		// the user's intent without trying to interpret HTML as page-data.
		fallbackToFullReload(targetPath);
		return;
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (err) {
		console.error(
			"[photon] SPA-nav JSON parse failed; falling back to full reload.",
			err,
		);
		fallbackToFullReload(targetPath);
		return;
	}

	// Re-check after every async boundary — `response.json()` may have yielded
	// to the event loop long enough for a fresher click to overtake.
	if (ownSeq !== navigationSeq) return;

	const newPageData = parsePageData(payload);
	if (!newPageData) {
		fallbackToFullReload(targetPath);
		return;
	}

	await applyPageData(newPageData, options, /* fromHistory */ false, ownSeq);
}

async function applyPageData(
	pageData: PhotonPageData,
	options: BootRouterOptions,
	fromHistory: boolean,
	expectedSeq?: number,
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
			typeof location !== "undefined" &&
			resolvedSameUrl(pageData.url, location.href);
		try {
			if (sameUrl && typeof history.replaceState === "function") {
				history.replaceState({ photonData: pageData }, "", pageData.url);
			} else {
				history.pushState({ photonData: pageData }, "", pageData.url);
			}
		} catch (err) {
			// Same-origin pushState should never throw under normal use; log and continue.
			console.error(
				"[photon] history.pushState failed; navigation will not appear in history.",
				err,
			);
		}
	}
}

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
	const state = event.state as { photonData?: unknown } | null;
	if (!state || typeof state !== "object" || !("photonData" in state)) {
		// No state (e.g. user navigated to a non-Photon URL). Full reload restores
		// browser intent without trying to interpret a non-Photon page in-flight.
		if (typeof location !== "undefined") {
			location.reload();
		}
		return;
	}

	const pageData = parsePageData(state.photonData);
	if (!pageData) {
		if (typeof location !== "undefined") {
			location.reload();
		}
		return;
	}

	await applyPageData(pageData, options, /* fromHistory */ true);
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
	return out;
}

function fallbackToFullReload(url: string): void {
	if (typeof location === "undefined") return;
	try {
		location.href = url;
	} catch {
		// Unreachable in real browsers; jsdom's restricted `location` setter may throw.
	}
}
