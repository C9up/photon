/// <reference lib="dom" />
// This file uses browser globals. The reference pulls the DOM lib in for
// THIS file whatever `lib` the consumer configured, so a Node app
// typechecking against our sources does not trip over `window` —
// `types: "./src/index.ts"` means every consumer reads them.
/**
 * Photon — Client hydration entrypoint.
 *
 * Reads the SSR-emitted `<script type="application/json" id="photon-data">`
 * block, dispatches to the framework-specific adapter (React `hydrateRoot` /
 * Vue `createSSRApp` / Svelte 5 `hydrate`), and boots a basic SPA-nav router
 * that intercepts internal `<a>` clicks to fetch props-only JSON via the
 * `X-Photon: true` header.
 *
 * Inertia.js-style API: the user supplies a `resolveComponent(name)` callback
 * (typically backed by Vite's `import.meta.glob('./pages/*.tsx')`) so only
 * on-demand chunks load. Photon owns DOM lookup, JSON parsing, framework
 * dispatch, and click interception.
 *
 * Browser-only — strict no `node:` imports.
 */

import type { MetaTags } from "../seo/Meta.js";
import type { PhotonAdapter } from "./adapters/types.js";
import { PhotonClientError } from "./errors.js";
import { readHistoryState, toHistoryState } from "./history.js";
import type { OncePropMeta } from "./mergeProps.js";
import {
	announceFlash,
	bootRouter,
	primeCurrentPage,
	type ResolveComponent,
	readDeferredProps,
	readOnceProps,
	readScrollProps,
} from "./router.js";

/** Frameworks supported by the bundled adapters. Mirrors `PhotonConfig.framework`. */
export type ClientFramework = "react" | "vue" | "svelte";

/** Shape of the page-data payload embedded in the SSR HTML by `PhotonRenderer`. */
export interface PhotonPageData {
	component: string;
	props: Record<string, unknown>;
	url: string;
	framework: ClientFramework;
	/**
	 * Server-resolved head metadata (`@Meta`, `ctx.photon.meta()`, and the
	 * global `defaultMeta`, all merged). Present on SPA-nav payloads
	 * (X-Photon) so the client can update `<title>`/`<meta>`/`<link>`
	 * without re-rendering the SSR head from scratch. Absent on the
	 * initial bootstrap (the SSR HTML already wrote those tags).
	 */
	meta?: MetaTags;
	/**
	 * The asset fingerprint the page was built against. The router echoes it
	 * as `x-photon-version`, and the server answers a stale one with a 409.
	 */
	version?: string;
	/** Forget every earlier history entry (the server sends it at logout). */
	clearHistory?: boolean;
	/** Store this page in history encrypted, never in the clear. */
	encryptHistory?: boolean;
	/** Props announced but not sent, by group: the client asks for each. */
	deferredProps?: Record<string, string[]>;
	/** Props a partial reload appends to what the client holds. */
	mergeProps?: string[];
	/** Props a partial reload puts before what the client holds. */
	prependProps?: string[];
	/** Props a partial reload merges recursively. */
	deepMergeProps?: string[];
	/** `prop.key` pairs: the field that identifies an item of a merged list. */
	matchPropsOn?: string[];
	/** The caching terms of every `once` prop, by key. */
	onceProps?: Record<string, OncePropMeta>;
	/** A one-shot bag beside the props, announced as `photon:flash`. */
	flash?: object;
	/** The pagination cursor of every scroll prop, by name. */
	scrollProps?: Record<string, ScrollPropMeta>;
	/** What `router.remember()` kept for this page, by key. */
	rememberedState?: Record<string, unknown>;
	/** Deferred props whose resolver failed and was rescued by the server. */
	rescuedProps?: string[];
}

/** Where a scroll prop is, and which pages come before and after it. */
export interface ScrollPropMeta {
	/** The query parameter the page is asked for with. */
	pageName: string;
	currentPage: number | string | null;
	nextPage: number | string | null;
	previousPage: number | string | null;
	/** True when the client asked to start the list over. */
	reset: boolean;
}

export interface HydrateOptions {
	/**
	 * Resolves a page component module by name. The resolved module's `default`
	 * export is the component handed to the framework adapter.
	 *
	 * Typical implementation backed by Vite's `import.meta.glob`:
	 *
	 * ```ts
	 * const pages = import.meta.glob('./pages/*.tsx')
	 * hydrate({
	 *   resolveComponent: (name) => pages[`./pages/${name}.tsx`]() as Promise<{ default: unknown }>,
	 * })
	 * ```
	 */
	resolveComponent: ResolveComponent;
	/** CSS selector for the mount target. Default: `'#app'`. */
	target?: string;
	/** Fires once after the initial hydrate completes. */
	onHydrated?: () => void;
	/**
	 * Svelte only: Photon's root, `import PhotonRoot from '@c9up/photon/svelte'`.
	 * The SSR entry must render the same root. Without it a page is remounted,
	 * losing its state, whenever its props change.
	 */
	svelteRoot?: unknown;
}

/**
 * Route name → its params, for `Link`, `Form` and `router.visit({ route })`.
 * Empty until the application augments it — then only those names, with those
 * params, type-check:
 *
 * ```ts
 * declare module '@c9up/photon/client' {
 *   interface PhotonRoutes extends RouteParams {} // from router.generateTypes()
 * }
 * ```
 *
 * Declared here, in the client entry, because an augmentation reaches only the
 * module that declares the interface.
 */
// biome-ignore lint/suspicious/noEmptyInterface: the application augments it (declaration merging); a type alias cannot be augmented.
export interface PhotonRoutes {}

export type { PhotonClientErrorCode } from "./errors.js";
/** Re-export so consumers can `instanceof`-check without a second import. */
export { PhotonClientError } from "./errors.js";
export {
	getScrollableParent,
	type InfiniteScrollData,
	type InfiniteScrollDataOptions,
	type InfiniteScrollElementManager,
	type InfiniteScrollOnCompleteDetails,
	type InfiniteScrollPageIdentifier,
	type UseInfiniteScrollOptions,
	type UseInfiniteScrollProps,
	useInfiniteScroll,
	useInfiniteScrollData,
} from "./infiniteScroll.js";
export type {
	PartialRequest,
	ResolveComponent,
	RouterEvents,
	VisitCallbacks,
	VisitOptions,
} from "./router.js";
export { router } from "./router.js";
export {
	getRoute,
	type RouteManifest,
	type RouteName,
	type RouteParamsFor,
	type RouteTarget,
	resolvePageComponent,
	setRoutes,
	urlFor,
} from "./routes.js";

/**
 * Tracks targets that have already been hydrated so a second `hydrate()` call
 * on the same DOM node is a no-op (instead of double-mounting).
 *
 * `WeakSet` lets the browser garbage-collect the target when it leaves the
 * document — no memory leak across SPA re-renders.
 */
const hydratedTargets = new WeakSet<Element>();

const PHOTON_DATA_ELEMENT_ID = "photon-data";

const SUPPORTED_FRAMEWORKS: readonly ClientFramework[] = [
	"react",
	"vue",
	"svelte",
];

/**
 * Boot the client: parse the SSR-embedded page-data, dispatch to the right
 * framework adapter, and install the SPA-nav click + popstate listeners.
 *
 * Idempotent on the same target — calling twice warns to `console.warn` and
 * returns without re-hydrating.
 */
export async function hydrate(options: HydrateOptions): Promise<void> {
	const targetSelector = options.target ?? "#app";

	const pageData = readPageData();
	const target = resolveTarget(targetSelector);

	// Idempotency guard — second call on a hydrated target is a no-op.
	if (hydratedTargets.has(target)) {
		console.warn(
			"[photon] hydrate() called twice on the same target; ignoring. " +
				"Did you import @c9up/photon/client from two places?",
		);
		return;
	}

	// A reload of the tab keeps what the page remembered: the entry it
	// overwrites belonged to this very page. Read before the key can be
	// cleared below, and before the first render, which may restore it.
	if (typeof history !== "undefined") {
		const previous: unknown = await readHistoryState(history.state);
		const remembered = rememberedStateOf(previous, pageData);
		if (remembered !== undefined) pageData.rememberedState = remembered;
	}
	// The page is known to the router before the framework renders it, so
	// `usePage()` reads during hydration the page the server rendered.
	primeCurrentPage(pageData);

	const componentModule = await options.resolveComponent(pageData.component);
	const Component = componentModule.default;

	const adapter = await loadAdapter(pageData.framework);
	const handle = await adapter.hydrate(target, Component, pageData.props, {
		svelteRoot: options.svelteRoot,
	});

	hydratedTargets.add(target);

	// Replace the initial history entry so back/forward have a valid state to
	// restore. Use `pageData.url` rather than `location.href` so the state stays
	// consistent with what the SSR captured.
	if (
		typeof history !== "undefined" &&
		typeof history.replaceState === "function"
	) {
		// Through `toHistoryState`, so a first page that asks for encryption is
		// never stored in the clear — and a login page reached after logout,
		// carrying `clearHistory`, drops the key before anything else is stored.
		const state = await toHistoryState(pageData);
		try {
			history.replaceState(state, "", pageData.url);
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

/** Locate and parse the `<script id="photon-data">` block. */
function readPageData(): PhotonPageData {
	const el =
		typeof document !== "undefined"
			? document.getElementById(PHOTON_DATA_ELEMENT_ID)
			: null;
	if (!el) {
		throw new PhotonClientError(
			"E_PHOTON_HYDRATION_NO_DATA",
			`Missing <script id="${PHOTON_DATA_ELEMENT_ID}"> in the document.`,
			{
				hint: "Render the page through PhotonRenderer.render() — the script block is emitted automatically.",
			},
		);
	}

	const raw = el.textContent ?? "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new PhotonClientError(
			"E_PHOTON_HYDRATION_BAD_DATA",
			"Failed to JSON.parse the photon-data block.",
			{
				hint: "The script block must contain valid JSON. Check for double-escaping or HTML mangling.",
				cause: err,
			},
		);
	}

	return validatePageData(parsed);
}

function validatePageData(value: unknown): PhotonPageData {
	if (!isPlainObject(value)) {
		throw new PhotonClientError(
			"E_PHOTON_HYDRATION_BAD_DATA",
			"photon-data must be a JSON object.",
			{
				hint: "Expected { component, props, url, framework } — got non-object.",
			},
		);
	}

	const { component, props, url, framework } = value as Record<string, unknown>;

	if (typeof component !== "string" || component.length === 0) {
		throw new PhotonClientError(
			"E_PHOTON_HYDRATION_BAD_DATA",
			"photon-data.component must be a non-empty string.",
		);
	}
	if (!isPlainObject(props)) {
		throw new PhotonClientError(
			"E_PHOTON_HYDRATION_BAD_DATA",
			"photon-data.props must be an object.",
		);
	}
	if (typeof url !== "string") {
		throw new PhotonClientError(
			"E_PHOTON_HYDRATION_BAD_DATA",
			"photon-data.url must be a string.",
		);
	}
	if (typeof framework !== "string") {
		throw new PhotonClientError(
			"E_PHOTON_HYDRATION_BAD_DATA",
			"photon-data.framework must be a string.",
			{ hint: `Got: ${typeof framework}.` },
		);
	}
	if (!SUPPORTED_FRAMEWORKS.includes(framework as ClientFramework)) {
		// String but not one of the supported values — escalate to UNSUPPORTED_FRAMEWORK
		// so consumers can distinguish "malformed payload" (BAD_DATA) from
		// "well-formed but framework not bundled" (UNSUPPORTED_FRAMEWORK).
		throw new PhotonClientError(
			"E_PHOTON_HYDRATION_UNSUPPORTED_FRAMEWORK",
			`Unsupported framework: '${framework}'.`,
			{ hint: `Supported: ${SUPPORTED_FRAMEWORKS.join(", ")}.` },
		);
	}

	const out: PhotonPageData = {
		component,
		props: props as Record<string, unknown>,
		url,
		framework: framework as ClientFramework,
	};

	const meta = (value as Record<string, unknown>).meta;
	if (isPlainObject(meta)) {
		out.meta = meta as MetaTags;
	}
	const version = (value as Record<string, unknown>).version;
	if (typeof version === "string") out.version = version;
	const { clearHistory, encryptHistory } = value as Record<string, unknown>;
	if (clearHistory === true) out.clearHistory = true;
	if (encryptHistory === true) out.encryptHistory = true;
	const deferredProps = readDeferredProps(
		(value as Record<string, unknown>).deferredProps,
	);
	if (deferredProps !== undefined) out.deferredProps = deferredProps;
	const onceProps = readOnceProps((value as Record<string, unknown>).onceProps);
	if (onceProps !== undefined) out.onceProps = onceProps;
	const flash = (value as Record<string, unknown>).flash;
	if (typeof flash === "object" && flash !== null) out.flash = flash;
	const scrollProps = readScrollProps(
		(value as Record<string, unknown>).scrollProps,
	);
	if (scrollProps !== undefined) out.scrollProps = scrollProps;
	const rescued = (value as Record<string, unknown>).rescuedProps;
	if (Array.isArray(rescued) && rescued.every((p) => typeof p === "string")) {
		out.rescuedProps = rescued;
	}

	return out;
}

function resolveTarget(selector: string): Element {
	const target =
		typeof document !== "undefined" ? document.querySelector(selector) : null;
	if (!target) {
		throw new PhotonClientError(
			"E_PHOTON_HYDRATION_NO_TARGET",
			`No DOM node matched the hydrate target selector ${selector}.`,
			{
				hint: 'PhotonRenderer emits <div id="app">…</div> by default. Override via hydrate({ target }).',
			},
		);
	}
	return target;
}

async function loadAdapter(framework: ClientFramework): Promise<PhotonAdapter> {
	if (!SUPPORTED_FRAMEWORKS.includes(framework)) {
		throw new PhotonClientError(
			"E_PHOTON_HYDRATION_UNSUPPORTED_FRAMEWORK",
			`Unsupported framework: ${framework}.`,
			{ hint: `Supported: ${SUPPORTED_FRAMEWORKS.join(", ")}.` },
		);
	}

	try {
		switch (framework) {
			case "react": {
				const mod = await import("./adapters/react.js");
				return mod.reactAdapter;
			}
			case "vue": {
				const mod = await import("./adapters/vue.js");
				return mod.vueAdapter;
			}
			case "svelte": {
				const mod = await import("./adapters/svelte.js");
				return mod.svelteAdapter;
			}
		}
	} catch (err) {
		if (err instanceof PhotonClientError) throw err;
		throw new PhotonClientError(
			"E_PHOTON_HYDRATION_ADAPTER_LOAD_FAILED",
			`Failed to load the ${framework} adapter.`,
			{
				hint: `Install the framework's runtime as a dependency: pnpm add ${frameworkInstallSpec(framework)}.`,
				cause: err,
			},
		);
	}
}

function frameworkInstallSpec(framework: ClientFramework): string {
	switch (framework) {
		case "react":
			return "react react-dom";
		case "vue":
			return "vue";
		case "svelte":
			return "svelte";
	}
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
