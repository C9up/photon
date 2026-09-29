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

import type { MetaTags } from "../seo/Meta.js";
import type { PhotonAdapterHandle } from "./adapters/types.js";
import { PhotonClientError } from "./errors.js";
import { readHistoryState, toHistoryState } from "./history.js";
import type { ClientFramework, PhotonPageData } from "./hydrate.js";
import {
	announceFlash,
	bootRouter,
	primeCurrentPage,
	type ResolveComponent,
	readDeferredProps,
	readOnceProps,
	readScrollProps,
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

export const SUPPORTED_FRAMEWORKS: readonly ClientFramework[] = [
	"react",
	"vue",
	"svelte",
];

export interface BootPageOptions {
	/** CSS selector for the mount target. */
	target: string;
	resolveComponent: ResolveComponent;
	/**
	 * Put the first page on screen, and hand back what the router updates on
	 * every visit.
	 */
	mount(
		target: Element,
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
	const targetSelector = options.target;

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

	const handle = await options.mount(target, Component, pageData);

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
