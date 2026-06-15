/**
 * Photon Middleware — integrates Photon into the Ream pipeline.
 *
 * - Attaches ctx.photon to every request
 * - Detects X-Photon header for SPA navigation (returns JSON props)
 * - Dev mode: no Vite HMR proxy is implemented yet — SSR is skipped in dev
 *   (PhotonRenderer.boot() returns early), so the client hydrates an empty shell
 *
 * @implements FR89, FR92
 */

import type { PhotonContext } from "./PhotonContext.js";
import { createPhotonContext } from "./PhotonContext.js";
import type { PhotonConfig } from "./PhotonRenderer.js";
import { PhotonRenderer } from "./PhotonRenderer.js";
import { type MetaTags, mergeMeta } from "./seo/Meta.js";
import { getRouteMeta, resolveMeta } from "./seo/MetaDecorator.js";

export interface PhotonMiddlewareContext {
	request?: {
		method(): string;
		path(): string;
		header(name: string): string | undefined;
	};
	response?: {
		status(code: number): PhotonMiddlewareContext["response"];
		header(name: string, value: string): PhotonMiddlewareContext["response"];
		send(body: string): void;
		getHeader(name: string): string | undefined;
	};
	photon?: PhotonContext;
	/**
	 * Optional duck-typed route handler metadata. Populated by Ream's
	 * `HttpKernel` from `match.route.controller` since 2026-05-05 — the
	 * `RouteInfo.controller` (prototype) + `RouteInfo.action` (method
	 * name) fields are the official wire for decorator metadata. When
	 * the route handler is an inline arrow function (no controller
	 * class), both fields are absent and the decorator path is inert
	 * — the imperative `ctx.photon.meta()` API and `defaultMeta` config
	 * still work.
	 *
	 * Mirrors Warden's middleware shape (warden/middleware.ts:62-66) so
	 * both `@Guard`/`@Permission`/`@Role` and `@Meta` decorators read
	 * from the same place.
	 */
	route?: {
		controller?: object;
		action?: string | symbol;
	};
}

/** Backward-compatible alias (historical typo). */
export type PhotronMiddlewareContext = PhotonMiddlewareContext;

/**
 * Seed the per-request meta accumulator from a route handler's `@Meta()`
 * decorator, when the upstream router populated `ctx.route`.
 *
 * A throwing or rejecting decorator factory must NOT 500 the request —
 * head metadata is a non-essential concern. We log the failure to stderr
 * and proceed without seeding; the handler can still emit tags imperatively.
 */
async function seedRouteMeta(
	baseContext: PhotonContext,
	ctx: PhotonMiddlewareContext,
): Promise<void> {
	const controller = ctx.route?.controller;
	const action = ctx.route?.action;
	if (!controller || action === undefined) return;
	try {
		const resolver = getRouteMeta(controller, action);
		const resolved = await resolveMeta(resolver, ctx);
		if (resolved) baseContext.meta(resolved);
	} catch (err) {
		console.warn(
			`[photon] @Meta resolver threw for ${String(action)}: ${err instanceof Error ? err.message : String(err)} — proceeding without decorator meta`,
		);
	}
}

/**
 * Create the Photon middleware for the Ream pipeline.
 *
 * Usage:
 *   const photon = PhotonMiddleware({ framework: 'react', entryClient: '...', entryServer: '...' })
 *   app.use(photon.middleware())
 */
export class PhotonMiddleware {
	private renderer: PhotonRenderer;
	private bootPromise?: Promise<void>;

	constructor(config: PhotonConfig) {
		this.renderer = new PhotonRenderer(config);
	}

	/**
	 * Get the Ream middleware function.
	 */
	middleware() {
		return async (ctx: PhotonMiddlewareContext, next: () => Promise<void>) => {
			// Boot renderer once (race-safe via promise latch)
			if (!this.bootPromise) {
				this.bootPromise = this.renderer.boot().catch((err) => {
					this.bootPromise = undefined;
					throw err;
				});
			}
			await this.bootPromise;

			const req = ctx.request as Record<string, unknown> | undefined;
			const url = req
				? typeof req.path === "function"
					? (req.path as () => string)()
					: ((req.path as string) ?? "/")
				: "/";

			let lastRenderArgs:
				| {
						component: string;
						props: Record<string, unknown>;
						url: string;
						metaOverride?: MetaTags;
				  }
				| undefined;
			const baseContext = createPhotonContext(this.renderer, url);

			// Seed the per-request meta accumulator from `@Meta()` on the
			// route handler before next() so the controller can still
			// override via `ctx.photon.meta(...)`.
			await seedRouteMeta(baseContext, ctx);

			ctx.photon = {
				render: async (component, props = {}, meta) => {
					lastRenderArgs = { component, props, url, metaOverride: meta };
					return baseContext.render(component, props, meta);
				},
				meta: (tags) => baseContext.meta(tags),
				getAccumulatedMeta: () => baseContext.getAccumulatedMeta(),
			};

			const xPhoton = req
				? typeof req.header === "function"
					? (req.header as (n: string) => string | undefined)("x-photon")
					: (req.headers as Record<string, string> | undefined)?.["x-photon"]
				: undefined;
			const isPhotonRequest = xPhoton === "true";

			await next();

			const res = ctx.response as Record<string, unknown> | undefined;
			const ct = res
				? typeof res.getHeader === "function"
					? (res.getHeader as (n: string) => string | undefined)("content-type")
					: (res.headers as Record<string, string> | undefined)?.[
							"content-type"
						]
				: undefined;

			if (
				isPhotonRequest &&
				lastRenderArgs &&
				ct?.includes("text/html") &&
				res
			) {
				// Forward whatever the SSR pipeline would have serialized into
				// `<head>` (decorator seed + imperative ctx.photon.meta() +
				// render-call override). The renderer composes this with the
				// global `defaultMeta`.
				const finalMeta = mergeMeta(
					baseContext.getAccumulatedMeta(),
					lastRenderArgs.metaOverride,
				);
				const propsOnly = this.renderer.renderProps(
					lastRenderArgs.component,
					lastRenderArgs.props,
					lastRenderArgs.url,
					finalMeta,
				);
				if (typeof res.status === "function") {
					(res.status as (c: number) => void)(propsOnly.status);
					const hdr = res.header as
						| ((k: string, v: string) => void)
						| undefined;
					if (hdr)
						for (const [k, v] of Object.entries(propsOnly.headers)) hdr(k, v);
					const send = res.send as ((body: string) => void) | undefined;
					if (send) send(propsOnly.html);
				} else {
					res.status = propsOnly.status;
					res.headers = {
						...((res.headers as Record<string, string>) ?? {}),
						...propsOnly.headers,
					};
					res.body = propsOnly.html;
				}
			}
		};
	}

	/**
	 * Get the renderer instance (for direct access in providers).
	 */
	getRenderer(): PhotonRenderer {
		return this.renderer;
	}
}
