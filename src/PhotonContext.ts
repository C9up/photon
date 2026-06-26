/**
 * Photon Context — extends the Ream request context with page rendering
 * and per-request `<head>` metadata accumulation.
 *
 * @implements FR91
 */

import type { PhotonRenderer, RenderResult } from "./PhotonRenderer.js";
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

	return {
		share(data: Record<string, unknown>): void {
			shared = { ...shared, ...data };
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
			);
		},
	};
}
