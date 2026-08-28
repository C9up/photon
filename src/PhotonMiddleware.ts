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

// An EMPTY type import: it brings `@c9up/ream` into the program so the
// augmentation below has a module to attach to, without importing a value or
// creating a runtime dependency. ream is already a peer.
import type {} from "@c9up/ream";
import type { PhotonContext } from "./PhotonContext.js";

/**
 * Teach ream's `HttpContext` about `ctx.photon`, so a route handler can
 * destructure it — `async ({ photon, response }) => …`.
 *
 * Declaration merging is how an AdonisJS package adds to the context
 * (`@adonisjs/session` merges `session` the same way). Without it the
 * middleware set the property at runtime and no consumer could see it.
 */
declare module "@c9up/ream" {
	interface HttpContext {
		photon: PhotonContext;
	}
}

import { createPhotonContext } from "./PhotonContext.js";
import type { PhotonConfig } from "./PhotonRenderer.js";
import { PhotonRenderer } from "./PhotonRenderer.js";
import { type PropsRequest, resolveProps } from "./props.js";
import { type MetaTags, mergeMeta } from "./seo/Meta.js";
import { getRouteMeta, resolveMeta } from "./seo/MetaDecorator.js";

/** The single surface these validation errors need of a session flash bag. */
interface FlashBagReader {
	get(path: string | readonly string[], defaultValue?: unknown): unknown;
}

function flashBagOf(ctx: unknown): FlashBagReader | undefined {
	const session = Reflect.get(Object(ctx), "session");
	if (typeof session !== "object" || session === null) return undefined;
	const bag = Reflect.get(session, "flashMessages");
	if (typeof bag !== "object" || bag === null) return undefined;
	const read = Reflect.get(bag, "get");
	if (typeof read !== "function") return undefined;
	return {
		get: (path, fallback) => Reflect.apply(read, bag, [path, fallback]),
	};
}

export interface ValidationErrorOptions {
	/** Every message per field, rather than only the first one. */
	allMessages?: boolean;
}

/**
 * The validation errors the session flashed, in the shape a form reads.
 *
 * A page component does `errors.email`, so each field collapses to its FIRST
 * message unless `allMessages` asks for the list. Nothing flashed, or no
 * session at all, gives `{}` — never undefined, because a component that has
 * to guard every read is a component that will forget to.
 */
export function getValidationErrors(
	ctx: unknown,
	options?: ValidationErrorOptions,
): Record<string, unknown> {
	const raw = flashBagOf(ctx)?.get("inputErrorsBag", {});
	if (typeof raw !== "object" || raw === null) return {};
	const errors: Record<string, unknown> = {};
	for (const [field, messages] of Object.entries(raw)) {
		if (options?.allMessages === true) {
			errors[field] = Array.isArray(messages) ? messages : [messages];
		} else {
			errors[field] = Array.isArray(messages) ? messages[0] : messages;
		}
	}
	return errors;
}

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
/** A comma-separated header list, trimmed and without empties. */
function splitHeaderList(raw: string | undefined): string[] {
	if (raw === undefined || raw.trim() === "") return [];
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/** Methods whose redirect must become a 303 so the next hop is a GET. */
const MUTATION_METHODS = new Set(["PUT", "PATCH", "DELETE"]);

/** The request method, however the host exposes it. */
function readMethod(ctx: PhotonMiddlewareContext): string {
	const req = Reflect.get(Object(ctx), "request");
	const viaMethod = Reflect.get(Object(req), "method");
	if (typeof viaMethod === "function") {
		const value = viaMethod.call(req);
		return typeof value === "string" ? value.toUpperCase() : "GET";
	}
	return typeof viaMethod === "string" ? viaMethod.toUpperCase() : "GET";
}

/** The status already set on the response, however the host exposes it. */
function readStatus(res: Record<string, unknown>): number | undefined {
	const getter = Reflect.get(res, "getStatus");
	if (typeof getter === "function") {
		const value = getter.call(res);
		return typeof value === "number" ? value : undefined;
	}
	const direct = Reflect.get(res, "statusCode") ?? Reflect.get(res, "status");
	return typeof direct === "number" ? direct : undefined;
}

/** Write a bodyless response through whichever shape the host provides. */
function writeResponse(
	res: Record<string, unknown>,
	status: number,
	headers: Record<string, string>,
): void {
	const setStatus = Reflect.get(res, "status");
	if (typeof setStatus === "function") {
		setStatus.call(res, status);
		const header = Reflect.get(res, "header");
		if (typeof header === "function") {
			for (const [k, v] of Object.entries(headers)) header.call(res, k, v);
		}
		const send = Reflect.get(res, "send");
		if (typeof send === "function") send.call(res, "");
		return;
	}
	res.status = status;
	const existing = Reflect.get(res, "headers");
	res.headers = {
		...(typeof existing === "object" && existing !== null ? existing : {}),
		...headers,
	};
	res.body = "";
}

export class PhotonMiddleware {
	#renderer: PhotonRenderer;
	#bootPromise?: Promise<void>;

	constructor(config: PhotonConfig) {
		this.#renderer = new PhotonRenderer(config);
	}

	/**
	 * Get the Ream middleware function.
	 */
	middleware() {
		return async (ctx: PhotonMiddlewareContext, next: () => Promise<void>) => {
			// Boot renderer once (race-safe via promise latch)
			if (!this.#bootPromise) {
				this.#bootPromise = this.#renderer.boot().catch((err) => {
					this.#bootPromise = undefined;
					throw err;
				});
			}
			await this.#bootPromise;

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
			const baseContext = createPhotonContext(this.#renderer, url);

			// Seed the per-request meta accumulator from `@Meta()` on the
			// route handler before next() so the controller can still
			// override via `ctx.photon.meta(...)`.
			await seedRouteMeta(baseContext, ctx);

			ctx.photon = {
				render: async (component, props = {}, meta) => {
					lastRenderArgs = { component, props, url, metaOverride: meta };
					return baseContext.render(component, props, meta);
				},
				share: (data) => baseContext.share(data),
				clearHistory: () => baseContext.clearHistory(),
				encryptHistory: (encrypt) => baseContext.encryptHistory(encrypt),
				flash: (provider) => baseContext.flash(provider),
				resolvePageFlags: () => baseContext.resolvePageFlags(),
				getVersion: () => baseContext.getVersion(),
				ssrEnabled: (component) => baseContext.ssrEnabled(component),
				sharedKeys: () => baseContext.sharedKeys(),
				meta: (tags) => baseContext.meta(tags),
				getAccumulatedMeta: () => baseContext.getAccumulatedMeta(),
				location: (target) => baseContext.location(target),
				takeLocation: () => baseContext.takeLocation(),
			};

			const readHeader = (name: string): string | undefined => {
				if (!req) return undefined;
				const viaMethod = Reflect.get(Object(req), "header");
				if (typeof viaMethod === "function") {
					const value = viaMethod.call(req, name);
					return typeof value === "string" ? value : undefined;
				}
				const bag = Reflect.get(Object(req), "headers");
				const value =
					typeof bag === "object" && bag !== null
						? Reflect.get(bag, name)
						: undefined;
				return typeof value === "string" ? value : undefined;
			};
			const isPhotonRequest = readHeader("x-photon") === "true";
			// Partial reload (AdonisJS Inertia's `x-inertia-partial-*`): reload a
			// page without recomputing every prop. `component` guards it — a
			// client asking about another page must not get a half-filled one.
			const partial: PropsRequest = {
				only: splitHeaderList(readHeader("x-photon-partial-data")),
				except: splitHeaderList(readHeader("x-photon-partial-except")),
				component: readHeader("x-photon-partial-component"),
				// `reset` says "replace these, do not merge them" — the client
				// clearing a list before loading its first page again.
				reset: splitHeaderList(readHeader("x-photon-reset")),
				// Once-keys the client still holds: those props are not resolved.
				exceptOnce: splitHeaderList(readHeader("x-photon-except-once-props")),
				// Which way a scroll prop's new page joins the rows already shown.
				mergeIntent:
					readHeader("x-photon-infinite-scroll-merge-intent") === "prepend"
						? "prepend"
						: "append",
			};

			// Validation errors are shared with every page: a form component reads
			// `errors.email` unconditionally, so the key has to be there. An
			// error-bag header scopes them, which is how two forms on one page
			// keep their messages apart. A controller's own `errors` prop wins.
			const errorBag = readHeader("x-photon-error-bag");
			const errors = getValidationErrors(ctx);
			baseContext.share({ errors: errorBag ? { [errorBag]: errors } : errors });

			await next();

			const res = ctx.response as Record<string, unknown> | undefined;
			const ct = res
				? typeof res.getHeader === "function"
					? (res.getHeader as (n: string) => string | undefined)("content-type")
					: (res.headers as Record<string, string> | undefined)?.[
							"content-type"
						]
				: undefined;

			// A 409 tells the SPA client to leave the fetch loop and navigate for
			// real. Two things ask for it, and both must be answered BEFORE any
			// props are rendered — there is no page to send in either case.
			if (isPhotonRequest && res) {
				const explicit = ctx.photon?.takeLocation?.();
				const version = this.#renderer.getVersion();
				// ABSENT means "this client does not speak versioning", not
				// "version empty". AdonisJS never meets the case — its client
				// always sends the header — but ours predates it, and forcing a
				// reload on every one of those requests would break them all.
				const clientVersion = readHeader("x-photon-version");
				const method = readMethod(ctx);
				// An explicit `location()` wins; otherwise a stale asset version
				// forces a hard reload of the SAME url so the client picks up the
				// new bundles. Only on GET: replaying a mutation would be worse
				// than a stale page.
				const target =
					explicit ??
					(method === "GET" &&
					clientVersion !== undefined &&
					clientVersion !== version
						? // The CURRENT url, not the last render: a stale version
							// must reload where the client actually is, and it may
							// have been rejected before any render ran.
							url
						: undefined);
				if (target !== undefined) {
					writeResponse(res, 409, {
						"x-photon-location": target,
						"x-photon-version": version,
						vary: "x-photon",
					});
					return;
				}
				// A 302 after a mutation makes the browser repeat the method on
				// the next hop; 303 forces the GET the client expects.
				if (
					MUTATION_METHODS.has(method) &&
					readStatus(res) === 302 &&
					typeof res.status === "function"
				) {
					const setStatus = Reflect.get(res, "status");
					if (typeof setStatus === "function") setStatus.call(res, 303);
				}
			}

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
				// Resolve the props against the partial request: `only`/`except`
				// narrow the set, `always()` survives it, and an `optional()`
				// resolver runs ONLY if it was named.
				const resolved = await resolveProps(
					lastRenderArgs.props,
					lastRenderArgs.component,
					partial,
				);
				const propsOnly = this.#renderer.renderProps(
					lastRenderArgs.component,
					resolved.props,
					lastRenderArgs.url,
					finalMeta,
					{ ...resolved.extras, ...(await baseContext.resolvePageFlags()) },
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
		return this.#renderer;
	}
}
