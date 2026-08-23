/**
 * Photon Context — extends the Ream request context with page rendering
 * and per-request `<head>` metadata accumulation.
 *
 * @implements FR91
 */

import type {
	PageFlags,
	PhotonRenderer,
	RenderResult,
} from "./PhotonRenderer.js";
import { type MetaTags, mergeMeta } from "./seo/Meta.js";

export interface PhotonContext {
	/**
	 * Render a page component with props.
	 *
	 * Usage in a route handler:
	 *   ctx.photon.render('Dashboard', { user, stats })
	 *   // or with a per-call meta override:
	 *   ctx.photon.render('Dashboard', { user }, { title: 'Dashboard' })
	 */
	render(
		component: string,
		props?: Record<string, unknown>,
		meta?: MetaTags,
	): Promise<RenderResult>;
	/**
	 * Share props across every `render()` of this request — AdonisJS Inertia's
	 * `inertia.share({...})`. Use for cross-cutting data (auth user, flash, locale)
	 * so handlers don't repeat it. Multiple calls shallow-merge (last wins per key);
	 * a per-call `render(props)` key overrides a shared one.
	 */
	share(data: Record<string, unknown>): void;
	/**
	 * Send the client to another URL, including one outside the app
	 * (AdonisJS Inertia's `inertia.location`).
	 *
	 * A normal 302 cannot work here: the SPA client would follow it with its
	 * own fetch and receive HTML it cannot mount. The protocol answer is a 409
	 * carrying the target, which the client turns into a real browser
	 * navigation.
	 */
	location(url: string): void;
	/**
	 * Imperatively set / accumulate `<head>` metadata for this request.
	 * Multiple calls deep-merge (last wins per leaf field).
	 */
	meta(tags: MetaTags): void;
	/**
	 * Read back the meta accumulated so far by `meta()` / decorator seed.
	 * Used by the middleware to forward head data on SPA-nav (X-Photon)
	 * responses, where the SSR HTML — and thus the serialized head — is
	 * dropped in favor of a JSON props payload.
	 */
	getAccumulatedMeta(): MetaTags | undefined;
	/**
	 * Tell the client to drop its cached history state after this response.
	 *
	 * Call it on logout: without it, the back button replays pages built from
	 * the previous session's data, straight out of the client's own cache.
	 */
	clearHistory(): void;
	/**
	 * Encrypt the history state the client stores for this response.
	 *
	 * Worth it wherever a page holds data that should not sit in the browser's
	 * history after the user signs out.
	 */
	encryptHistory(encrypt?: boolean): void;
	/**
	 * Provide the one-shot bag sent beside the props as `flash`.
	 *
	 * Unlike shared state it is NOT merged into the props: it is a sibling
	 * field, so a message shows once and does not come back with the next
	 * partial reload. The last registration wins.
	 *
	 *   ctx.photon.flash(() => ctx.session.flashMessages.all())
	 */
	flash(provider: () => unknown): void;
	/** The asset fingerprint this response is built against. */
	getVersion(): string;
	/** Whether `component` is server-rendered under the current config. */
	ssrEnabled(component: string): Promise<boolean>;
	/** Internal: the keys `share()` has contributed so far. */
	sharedKeys(): string[];
	/** Internal: the response flags accumulated for this request. */
	resolvePageFlags(): Promise<PageFlags>;
	/** Internal: the pending `location()` target, cleared once read. */
	takeLocation(): string | undefined;
}

/**
 * Create a Photon context bound to a renderer. Attached to `ctx.photon`
 * by `PhotonMiddleware`.
 *
 * The returned context owns a per-request meta accumulator. Callers
 * stack tags via `meta()`, then `render()` composes them with any
 * explicit `meta` argument (which wins over the accumulator).
 */
export function createPhotonContext(
	renderer: PhotonRenderer,
	url: string,
): PhotonContext {
	let accumulated: MetaTags | undefined;
	let shared: Record<string, unknown> = {};
	let shouldClearHistory = false;
	let shouldEncryptHistory = false;
	let flashProvider: (() => unknown) | undefined;
	// Set by `location()`, consumed once by the middleware.
	let redirectTo: string | undefined;

	return {
		share(data: Record<string, unknown>): void {
			shared = { ...shared, ...data };
		},
		getVersion(): string {
			return renderer.getVersion();
		},
		ssrEnabled(component: string): Promise<boolean> {
			return renderer.ssrEnabled(component);
		},
		sharedKeys(): string[] {
			return Object.keys(shared);
		},
		clearHistory(): void {
			shouldClearHistory = true;
		},
		encryptHistory(encrypt = true): void {
			shouldEncryptHistory = encrypt;
		},
		flash(provider: () => unknown): void {
			flashProvider = provider;
		},
		async resolvePageFlags(): Promise<PageFlags> {
			return {
				// Omitted unless true: the client defaults both to false, so an
				// ordinary page stays an ordinary page on the wire.
				...(shouldClearHistory ? { clearHistory: true } : {}),
				...(shouldEncryptHistory ? { encryptHistory: true } : {}),
				...(flashProvider ? { flash: await flashProvider() } : {}),
			};
		},
		location(url: string): void {
			redirectTo = url;
		},
		takeLocation(): string | undefined {
			const target = redirectTo;
			redirectTo = undefined;
			return target;
		},
		meta(tags: MetaTags): void {
			accumulated = mergeMeta(accumulated, tags);
		},
		getAccumulatedMeta(): MetaTags | undefined {
			return accumulated;
		},
		async render(
			component: string,
			props: Record<string, unknown> = {},
			meta?: MetaTags,
		): Promise<RenderResult> {
			const finalMeta = mergeMeta(accumulated, meta);
			// Shared props are the base; per-call props win on key conflicts.
			return renderer.render(
				component,
				{ ...shared, ...props },
				url,
				finalMeta,
				await this.resolvePageFlags(),
				Object.keys(shared),
			);
		},
	};
}
