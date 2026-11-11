/**
 * Photon Middleware — integrates Photon into the Ream pipeline.
 *
 * - Attaches ctx.photon to every request
 * - Detects X-Photon header for SPA navigation (returns JSON props)
 * - Dev mode: the renderer compiles the SSR entry through Vite per render, so
 *   SSR runs here too; without Vite installed it degrades to a client-only
 *   shell
 *
 * @implements FR89, FR92
 */

// An EMPTY type import: it brings `@c9up/ream` into the program so the
// augmentation below has a module to attach to, without importing a value or
// creating a runtime dependency. ream is already a peer.
import type {} from "@c9up/ream";
import type { PhotonContext, SharedData } from "./PhotonContext.js";

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
import {
	readRequestHeader,
	readRequestUrl,
	shouldReloadForAssetVersion,
} from "./requestInfo.js";
import { readResponseHeader } from "./requestSecurity.js";
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
 *
 * An `x-photon-error-bag` header scopes them, which is how two forms on one
 * page keep their messages apart — but only when there are errors: the client
 * reads any key in `errors` as a failed submission.
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
	const errorBag = readRequestHeader(ctx, "x-photon-error-bag");
	if (errorBag && Object.keys(errors).length > 0) return { [errorBag]: errors };
	return errors;
}

export interface PhotonMiddlewareContext {
	request?: {
		method(): string;
		path(): string;
		/** Path + query when asked for it (ream's `url(true)`); the page url. */
		url?(includeQueryString?: boolean): string;
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
 *   const photon = PhotonMiddleware({ framework: 'react', entryClient: '...', ssr: { enabled: true, entrypoint: '...' } })
 *   app.use(photon.middleware())
 */
/** Keep the session's flash messages for one more request, when it has them. */
function reflashSession(ctx: unknown): void {
	const session = Reflect.get(Object(ctx), "session");
	if (typeof session !== "object" || session === null) return;
	const reflash = Reflect.get(session, "reflash");
	if (typeof reflash === "function") reflash.call(session);
}

/** Methods whose redirect must become a 303 so the next hop is a GET. */
const MUTATION_METHODS = new Set(["PUT", "PATCH", "DELETE"]);

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

/**
 * Write a response through whichever shape the host provides.
 *
 * Every method is called ON the response. Ream's keeps its state in private
 * fields, so a method read off it and called bare throws — which is what the
 * props response did, on every SPA navigation, while the mocks in the tests
 * (plain closures) hid it.
 */
function writeResponse(
	res: Record<string, unknown>,
	status: number,
	headers: Record<string, string>,
	body = "",
): void {
	const setStatus = Reflect.get(res, "status");
	if (typeof setStatus === "function") {
		setStatus.call(res, status);
		const header = Reflect.get(res, "header");
		if (typeof header === "function") {
			for (const [k, v] of Object.entries(headers)) header.call(res, k, v);
		}
		const send = Reflect.get(res, "send");
		if (typeof send === "function") send.call(res, body);
		return;
	}
	res.status = status;
	const existing = Reflect.get(res, "headers");
	res.headers = {
		...(typeof existing === "object" && existing !== null ? existing : {}),
		...headers,
	};
	res.body = body;
}

/**
 * Add X-Photon to the response's Vary header.
 *
 * The same URL answers with a page or with its props depending on X-Photon, so
 * a cache that ignores the header can hand the JSON to a browser loading the
 * page, or the page to the client router. Every response, as upstream's
 * middleware does: whether a later handler renders is not known yet.
 */
function varyOnPhoton(res: Record<string, unknown>): void {
	const vary = Reflect.get(res, "vary");
	if (typeof vary === "function") {
		vary.call(res, "X-Photon");
		return;
	}
	const current = readResponseHeader(res, "vary");
	const fields = (current ?? "")
		.split(",")
		.map((field) => field.trim())
		.filter((field) => field.length > 0);
	if (fields.some((field) => field.toLowerCase() === "x-photon")) return;
	const value = [...fields, "X-Photon"].join(", ");
	const header = Reflect.get(res, "header");
	if (typeof header === "function") {
		header.call(res, "vary", value);
		return;
	}
	const existing = Reflect.get(res, "headers");
	res.headers = {
		...(typeof existing === "object" && existing !== null ? existing : {}),
		vary: value,
	};
}

export class PhotonMiddleware {
	#renderer: PhotonRenderer;
	#bootPromise?: Promise<void>;

	/**
	 * Props shared with every page of the request, defined by a subclass.
	 * Resolved when a page is built, after the handler ran.
	 *
	 *   class AppPhotonMiddleware extends PhotonMiddleware {
	 *     share(ctx) { return { user: ctx.auth?.user } }
	 *   }
	 */
	share?(ctx: PhotonMiddlewareContext): SharedData | Promise<SharedData>;

	/**
	 * The one-shot bag sent beside the props as `flash`, defined by a
	 * subclass. A handler's own `ctx.photon.flash()` replaces it.
	 */
	flash?(ctx: PhotonMiddlewareContext): unknown;

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

			const url = readRequestUrl(ctx);
			// The context goes through so an `ssr.pages` predicate can decide on
			// the request, as upstream's does, and so `render()` knows from the
			// protocol headers whether it answers a page load or a props request.
			// Nothing is stored on the renderer — it stays a singleton.
			const photon = createPhotonContext(this.#renderer, url, ctx);
			const info = photon.requestInfo();

			// Seed the per-request meta accumulator from `@Meta()` on the
			// route handler before next() so the controller can still
			// override via `ctx.photon.meta(...)`.
			await seedRouteMeta(photon, ctx);

			ctx.photon = photon;

			// Validation errors are shared with every page: a form component reads
			// `errors.email` unconditionally, so the key has to be there. A
			// controller's own `errors` prop wins, and so does the share() hook's.
			photon.share(() => ({ errors: getValidationErrors(ctx) }));
			// The application's hooks, registered as providers: they run when a
			// page is built, never on a request that renders none.
			const share = this.share;
			if (share !== undefined) photon.share(() => share.call(this, ctx));
			const flash = this.flash;
			if (flash !== undefined) photon.flash(() => flash.call(this, ctx));

			const res = ctx.response as Record<string, unknown> | undefined;
			if (res) varyOnPhoton(res);

			await next();

			// Read on every request, so a `location()` is never dropped.
			const explicit = (ctx.photon ?? photon).takeLocation();

			// NAMED DEVIATION: upstream answers `location()` with a 409 whatever
			// the request. A plain browser load has no client router to read it
			// and shows an empty error page; a 302 sends that browser on itself.
			if (!info.isPhotonRequest && res && explicit !== undefined) {
				writeResponse(res, 302, { location: explicit });
				return;
			}

			// A 409 tells the SPA client to leave the fetch loop and navigate for
			// real. Two things ask for it; there is no page to send in either case.
			if (info.isPhotonRequest && res) {
				const version = this.#renderer.getVersion();
				// An explicit `location()` wins; otherwise a stale asset version
				// forces a hard reload of the SAME url so the client picks up the
				// new bundles.
				const stale =
					explicit === undefined && shouldReloadForAssetVersion(info, version);
				const target = explicit ?? (stale ? url : undefined);
				// The flash messages this request consumed must survive the hard
				// reload, or a "Saved" landing right after a deploy is never shown.
				if (stale) reflashSession(ctx);
				if (target !== undefined) {
					writeResponse(res, 409, {
						"x-photon-location": target,
						"x-photon-version": version,
					});
					return;
				}
				// A 302 after a mutation makes the browser repeat the method on
				// the next hop; 303 forces the GET the client expects.
				if (
					MUTATION_METHODS.has(info.method) &&
					readStatus(res) === 302 &&
					typeof res.status === "function"
				) {
					const setStatus = Reflect.get(res, "status");
					if (typeof setStatus === "function") setStatus.call(res, 303);
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
