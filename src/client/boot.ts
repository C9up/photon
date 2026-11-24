/// <reference lib="dom" />
/**
 * Photon — the client's first page, whichever entry mounts it.
 *
 * `hydrate()` mounts it through a framework adapter; `createPhotonApp` from
 * `@c9up/photon/react`, `/vue` and `/svelte` through the app's own `setup`.
 * Both read the page the server embedded, restore what history remembered,
 * and start the router here.
 *
 * Browser-only — strict no `node:` imports.
 */

import { readMetaTags } from "../seo/Meta.js";
import type { PhotonAdapterHandle } from "./adapters/types.js";
import {
	E_PHOTON_HYDRATION_BAD_DATA,
	E_PHOTON_HYDRATION_NO_DATA,
	E_PHOTON_HYDRATION_NO_TARGET,
} from "./errors.js";
import { readHistoryState, toHistoryState } from "./history.js";
import { currentHost, installHost, type PhotonHost } from "./host.js";
import type { PhotonPageData } from "./hydrate.js";
import {
	announceFlash,
	bootRouter,
	pathOf,
	primeCurrentPage,
	type ResolveComponent,
	readDeferredProps,
	readOnceProps,
	readScrollProps,
	requestPage,
} from "./router.js";

/**
 * Tracks targets that have already been hydrated so a second `hydrate()` call
 * on the same DOM node is a no-op (instead of double-mounting).
 *
 * `WeakSet` lets the browser garbage-collect the target when it leaves the
 * document — no memory leak across SPA re-renders.
 */
const hydratedTargets = new WeakSet<Element>();

const PHOTON_DATA_ELEMENT_ID = "photon-data";

/**
 * Where the page object is read from: a JSON script, never any element with
 * the id. `getElementById` returns the first element of the document with that
 * id, whatever it is, so markup the page prints (a sanitized comment keeping
 * its `id`) could stand in for the page object — component, props, url and
 * history flags. Only a `<script type="application/json">` matches this, and
 * the server writes it before the mount element, so nothing the application
 * renders comes first.
 */
const PHOTON_DATA_SELECTOR = `script#${PHOTON_DATA_ELEMENT_ID}[type="application/json"]`;

export interface BootPageOptions {
	/** CSS selector for the mount target, in a browser. */
	target?: string;
	/**
	 * Where the router runs, when not in a browser: an app's address, back
	 * stack and requests (see `PhotonHost`).
	 */
	host?: PhotonHost;
	/**
	 * Fetch the first page from the server at `url`, as a visit would —
	 * for a host with no server-rendered document to read it from.
	 */
	url?: string;
	resolveComponent: ResolveComponent;
	/**
	 * Put the first page on screen, and hand back what the router updates on
	 * every visit.
	 */
	mount(
		target: Element | undefined,
		Component: unknown,
		page: PhotonPageData,
	): Promise<PhotonAdapterHandle>;
	onHydrated?: () => void;
}

/**
 * Boot the client: parse the SSR-embedded page-data, mount the first page,
 * and install the SPA-nav click + popstate listeners.
 *
 * Idempotent on the same target — calling twice warns to `console.warn` and
 * returns without re-hydrating.
 */
export async function bootPage(options: BootPageOptions): Promise<void> {
	installHost(options.host);
	const pageData =
		options.url === undefined
			? readPageData()
			: validatePageData(await requestPage(options.url));
	const target =
		options.target === undefined ? undefined : resolveTarget(options.target);

	// Idempotency guard — second call on a hydrated target is a no-op.
	if (target !== undefined && hydratedTargets.has(target)) {
		console.warn(
			"[photon] hydrate() called twice on the same target; ignoring. " +
				"Did you import @c9up/photon/client from two places?",
		);
		return;
	}

	// A reload of the tab keeps what the page remembered: the entry it
	// overwrites belonged to this very page. Read before the key can be
	// cleared below, and before the first render, which may restore it.
	const platform = currentHost();
	// The page's `url` is where deferred props and reloads are asked from. One
	// that resolves to another origin (a request path the server echoed back as
	// `//other.example/x`) gives way to the address the page was loaded at.
	if (platform !== undefined && !isOnCurrentOrigin(pageData.url, platform)) {
		pageData.url = pathOf(new URL(platform.href()));
	}
	if (platform !== undefined) {
		const previous: unknown = await readHistoryState(platform.state());
		const remembered = rememberedStateOf(previous, pageData);
		if (remembered !== undefined) pageData.rememberedState = remembered;
	}
	// The page is known to the router before the framework renders it, so
	// `usePage()` reads during hydration the page the server rendered.
	primeCurrentPage(pageData);

	const componentModule = await options.resolveComponent(pageData.component);
	const Component = componentModule.default;

	const handle = await options.mount(target, Component, pageData);

	if (target !== undefined) hydratedTargets.add(target);

	// Replace the initial history entry so back/forward have a valid state to
	// restore. Use `pageData.url` rather than `location.href` so the state stays
	// consistent with what the SSR captured.
	if (platform !== undefined) {
		// Through `toHistoryState`, so a first page that asks for encryption is
		// never stored in the clear — and a login page reached after logout,
		// carrying `clearHistory`, drops the key before anything else is stored.
		const state = await toHistoryState(pageData);
		try {
			platform.replace(state, pageData.url);
		} catch {
			// Some test environments (or very old browsers) restrict replaceState.
			// Hydration still succeeds; only SPA-nav back/forward will fall back to
			// a full reload on missing state.
		}
	}

	bootRouter({
		target,
		adapter: handle,
		resolveComponent: options.resolveComponent,
		page: pageData,
	});
	// After the page is up, as Inertia fires its initial events: a listener
	// registered by the page's own code must be there to hear it.
	queueMicrotask(() => announceFlash(pageData.flash));

	options.onHydrated?.();
}

/** Whether `url`, resolved against the current address, stays on its origin over http(s). */
function isOnCurrentOrigin(url: string, platform: PhotonHost): boolean {
	try {
		const here = new URL(platform.href());
		const resolved = new URL(url, here);
		return (
			resolved.origin === here.origin &&
			(resolved.protocol === "http:" || resolved.protocol === "https:")
		);
	} catch {
		return false;
	}
}

/** Locate and parse the `<script type="application/json" id="photon-data">` block. */
function readPageData(): PhotonPageData {
	const el =
		typeof document !== "undefined"
			? document.querySelector(PHOTON_DATA_SELECTOR)
			: null;
	if (!el) {
		throw new E_PHOTON_HYDRATION_NO_DATA(
			`Missing <script type="application/json" id="${PHOTON_DATA_ELEMENT_ID}"> in the document.`,
			{
				help: "Render the page through PhotonRenderer.render() — the script block is emitted automatically.",
			},
		);
	}

	const raw = el.textContent ?? "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new E_PHOTON_HYDRATION_BAD_DATA(
			"Failed to JSON.parse the photon-data block.",
			{
				help: "The script block must contain valid JSON. Check for double-escaping or HTML mangling.",
				cause: err,
			},
		);
	}

	return validatePageData(parsed);
}

function validatePageData(value: unknown): PhotonPageData {
	if (!isPlainObject(value)) {
		throw new E_PHOTON_HYDRATION_BAD_DATA(
			"photon-data must be a JSON object.",
			{
				help: "Expected { component, props, url, framework } — got non-object.",
			},
		);
	}

	const { component, props, url, framework } = value;

	if (typeof component !== "string" || component.length === 0) {
		throw new E_PHOTON_HYDRATION_BAD_DATA(
			"photon-data.component must be a non-empty string.",
		);
	}
	if (!isPlainObject(props)) {
		throw new E_PHOTON_HYDRATION_BAD_DATA(
			"photon-data.props must be an object.",
		);
	}
	if (typeof url !== "string") {
		throw new E_PHOTON_HYDRATION_BAD_DATA("photon-data.url must be a string.");
	}
	if (typeof framework !== "string") {
		throw new E_PHOTON_HYDRATION_BAD_DATA(
			"photon-data.framework must be a string.",
			{ help: `Got: ${typeof framework}.` },
		);
	}
	if (framework.length === 0) {
		throw new E_PHOTON_HYDRATION_BAD_DATA(
			"photon-data.framework must be a non-empty string.",
		);
	}
	// Which adapter mounts it is the caller's business: `hydrate()` refuses a
	// framework photon does not bundle (E_PHOTON_HYDRATION_UNSUPPORTED_FRAMEWORK),
	// `bootPage()` with its own `mount` takes any.

	const out: PhotonPageData = {
		component,
		props,
		url,
		framework,
	};

	const meta = readMetaTags(value.meta);
	if (meta !== undefined) out.meta = meta;
	const version = value.version;
	if (typeof version === "string") out.version = version;
	const { clearHistory, encryptHistory } = value;
	if (clearHistory === true) out.clearHistory = true;
	if (encryptHistory === true) out.encryptHistory = true;
	const deferredProps = readDeferredProps(value.deferredProps);
	if (deferredProps !== undefined) out.deferredProps = deferredProps;
	const onceProps = readOnceProps(value.onceProps);
	if (onceProps !== undefined) out.onceProps = onceProps;
	const flash = value.flash;
	if (typeof flash === "object" && flash !== null) out.flash = flash;
	const scrollProps = readScrollProps(value.scrollProps);
	if (scrollProps !== undefined) out.scrollProps = scrollProps;
	const rescued = value.rescuedProps;
	if (Array.isArray(rescued) && rescued.every((p) => typeof p === "string")) {
		out.rescuedProps = rescued;
	}

	return out;
}

function resolveTarget(selector: string): Element {
	const target =
		typeof document !== "undefined" ? document.querySelector(selector) : null;
	if (!target) {
		throw new E_PHOTON_HYDRATION_NO_TARGET(
			`No DOM node matched the hydrate target selector ${selector}.`,
			{
				help: 'PhotonRenderer emits <div id="app">…</div> by default. Override via hydrate({ target }).',
			},
		);
	}
	return target;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The remembered state of `previous` — the history entry the tab had before
 * this load — when it was this same page at this same URL.
 */
function rememberedStateOf(
	previous: unknown,
	page: PhotonPageData,
): Record<string, unknown> | undefined {
	if (typeof previous !== "object" || previous === null) return undefined;
	if (Reflect.get(previous, "component") !== page.component) return undefined;
	if (Reflect.get(previous, "url") !== page.url) return undefined;
	const remembered: unknown = Reflect.get(previous, "rememberedState");
	return typeof remembered === "object" &&
		remembered !== null &&
		!Array.isArray(remembered)
		? { ...remembered }
		: undefined;
}
