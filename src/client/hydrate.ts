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
import { bootPage } from "./boot.js";
import {
	E_PHOTON_HYDRATION_ADAPTER_LOAD_FAILED,
	E_PHOTON_HYDRATION_NO_TARGET,
	E_PHOTON_HYDRATION_UNSUPPORTED_FRAMEWORK,
} from "./errors.js";
import type { OncePropMeta } from "./mergeProps.js";
import { isPhotonClientError } from "./photonClientError.js";
import {
	isClientFramework,
	type ResolveComponent,
	SUPPORTED_FRAMEWORKS,
} from "./router.js";

/** Frameworks supported by the bundled adapters. Mirrors `PhotonConfig.framework`. */
export type ClientFramework = "react" | "vue" | "svelte";

/** Shape of the page-data payload embedded in the SSR HTML by `PhotonRenderer`. */
export interface PhotonPageData {
	component: string;
	props: Record<string, unknown>;
	url: string;
	/**
	 * The adapter that mounts the page: one photon bundles (`react`, `vue`,
	 * `svelte`) for `hydrate()`, or any name an application's own `mount`
	 * answers to through `bootPage()` (aurora's is `aurora`).
	 */
	framework: string;
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

export type { PhotonAdapterHandle } from "./adapters/types.js";
/**
 * Boot with an adapter of the application's own: photon's router drives the
 * visits, `mount` puts the first page on screen and returns what each visit
 * updates. `hydrate()` is this with one of photon's bundled adapters.
 */
export { type BootPageOptions, bootPage } from "./boot.js";
/** The client's errors, one class per code, to test with `instanceof`. */
export * as errors from "./errors.js";
/** Where the router runs: the browser by default, an app's host through `bootPage({ host })`. */
export { browserHost, type PhotonEvent, type PhotonHost } from "./host.js";
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
	PhotonClientError,
	PhotonClientErrorCode,
} from "./photonClientError.js";
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
 * Boot the client: parse the SSR-embedded page-data, dispatch to the right
 * framework adapter, and install the SPA-nav click + popstate listeners.
 *
 * Idempotent on the same target — calling twice warns to `console.warn` and
 * returns without re-hydrating.
 */
export async function hydrate(options: HydrateOptions): Promise<void> {
	await bootPage({
		target: options.target ?? "#app",
		resolveComponent: options.resolveComponent,
		onHydrated: options.onHydrated,
		mount: async (target, Component, page) => {
			const adapter = await loadAdapter(page.framework);
			if (target === undefined) {
				throw new E_PHOTON_HYDRATION_NO_TARGET(
					"hydrate() mounts into a DOM node; it was given none.",
				);
			}
			return adapter.hydrate(target, Component, page.props, {
				svelteRoot: options.svelteRoot,
			});
		},
	});
}

async function loadAdapter(framework: string): Promise<PhotonAdapter> {
	if (!isClientFramework(framework)) {
		throw new E_PHOTON_HYDRATION_UNSUPPORTED_FRAMEWORK(
			`Unsupported framework: ${framework}.`,
			{ help: `Supported: ${SUPPORTED_FRAMEWORKS.join(", ")}.` },
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
		if (isPhotonClientError(err)) throw err;
		throw new E_PHOTON_HYDRATION_ADAPTER_LOAD_FAILED(
			`Failed to load the ${framework} adapter.`,
			{
				help: `Install the framework's runtime as a dependency: pnpm add ${frameworkInstallSpec(framework)}.`,
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
