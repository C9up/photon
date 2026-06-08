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
import { bootRouter, type ResolveComponent } from "./router.js";

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
}

export type { PhotonClientErrorCode } from "./errors.js";
/** Re-export so consumers can `instanceof`-check without a second import. */
export { PhotonClientError } from "./errors.js";
export type { ResolveComponent } from "./router.js";

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

	const componentModule = await options.resolveComponent(pageData.component);
	const Component = componentModule.default;

	const adapter = await loadAdapter(pageData.framework);
	const handle = await adapter.hydrate(target, Component, pageData.props);

	hydratedTargets.add(target);

	// Replace the initial history entry so back/forward have a valid state to
	// restore. Use `pageData.url` rather than `location.href` so the state stays
	// consistent with what the SSR captured.
	if (
		typeof history !== "undefined" &&
		typeof history.replaceState === "function"
	) {
		try {
			history.replaceState({ photonData: pageData }, "", pageData.url);
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
	});

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
			"PHOTON_HYDRATION_NO_DATA",
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
			"PHOTON_HYDRATION_BAD_DATA",
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
			"PHOTON_HYDRATION_BAD_DATA",
			"photon-data must be a JSON object.",
			{
				hint: "Expected { component, props, url, framework } — got non-object.",
			},
		);
	}

	const { component, props, url, framework } = value as Record<string, unknown>;

	if (typeof component !== "string" || component.length === 0) {
		throw new PhotonClientError(
			"PHOTON_HYDRATION_BAD_DATA",
			"photon-data.component must be a non-empty string.",
		);
	}
	if (!isPlainObject(props)) {
		throw new PhotonClientError(
			"PHOTON_HYDRATION_BAD_DATA",
			"photon-data.props must be an object.",
		);
	}
	if (typeof url !== "string") {
		throw new PhotonClientError(
			"PHOTON_HYDRATION_BAD_DATA",
			"photon-data.url must be a string.",
		);
	}
	if (typeof framework !== "string") {
		throw new PhotonClientError(
			"PHOTON_HYDRATION_BAD_DATA",
			"photon-data.framework must be a string.",
			{ hint: `Got: ${typeof framework}.` },
		);
	}
	if (!SUPPORTED_FRAMEWORKS.includes(framework as ClientFramework)) {
		// String but not one of the supported values — escalate to UNSUPPORTED_FRAMEWORK
		// so consumers can distinguish "malformed payload" (BAD_DATA) from
		// "well-formed but framework not bundled" (UNSUPPORTED_FRAMEWORK).
		throw new PhotonClientError(
			"PHOTON_HYDRATION_UNSUPPORTED_FRAMEWORK",
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

	return out;
}

function resolveTarget(selector: string): Element {
	const target =
		typeof document !== "undefined" ? document.querySelector(selector) : null;
	if (!target) {
		throw new PhotonClientError(
			"PHOTON_HYDRATION_NO_TARGET",
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
			"PHOTON_HYDRATION_UNSUPPORTED_FRAMEWORK",
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
			"PHOTON_HYDRATION_ADAPTER_LOAD_FAILED",
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
