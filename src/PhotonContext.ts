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
	SsrRequestContext,
} from "./PhotonRenderer.js";
import { resolveProps } from "./props.js";
import {
	type PhotonRequestInfo,
	readRequestInfo,
	shouldReloadForAssetVersion,
} from "./requestInfo.js";
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
	 * navigation. A plain browser load (no client router yet) gets a 302 to
	 * the target instead.
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
	 * Encrypt the history state the client stores for this response, or
	 * (with `false`) not, whatever the config's `encryptHistory` says.
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
	/**
	 * What the protocol headers say about this request: a page load or a props
	 * request, the partial reload it asks for, the client's asset version.
	 */
	requestInfo(): PhotonRequestInfo;
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
	/**
	 * The HTTP context this request is being served on, handed to an
	 * `ssr.pages` predicate so a decision can turn on the request. Optional
	 * because a context can be built without one — a test, a render outside
	 * the HTTP pipeline.
	 */
	requestContext?: SsrRequestContext,
): PhotonContext {
	let accumulated: MetaTags | undefined;
	let shared: Record<string, unknown> = {};
	let shouldClearHistory = false;
	let shouldEncryptHistory = renderer.encryptsHistory();
	let flashProvider: (() => unknown) | undefined;
	// Set by `location()`, consumed once by the middleware.
	let redirectTo: string | undefined;
	const info = readRequestInfo(requestContext);
	const session = historySessionOf(requestContext);

	// A `clearHistory()` stored by an earlier request — the logout before the
	// redirect — is consumed by the first page built after it. Not by a request
	// about to be answered with the stale-version 409: the reload that follows
	// is the page that must carry it.
	const clearHistoryFromSession = (): boolean =>
		session !== undefined &&
		!shouldReloadForAssetVersion(info, renderer.getVersion()) &&
		session.has(CLEAR_HISTORY_SESSION_KEY) &&
		session.pull(CLEAR_HISTORY_SESSION_KEY, false) === true;

	const resolvePageFlags = async (): Promise<PageFlags> => ({
		// Omitted unless true: the client defaults both to false, so an
		// ordinary page stays an ordinary page on the wire.
		...(clearHistoryFromSession() || shouldClearHistory
			? { clearHistory: true }
			: {}),
		...(shouldEncryptHistory ? { encryptHistory: true } : {}),
		...(flashProvider ? { flash: await flashProvider() } : {}),
	});

	return {
		share(data: Record<string, unknown>): void {
			shared = { ...shared, ...data };
		},
		getVersion(): string {
			return renderer.getVersion();
		},
		ssrEnabled(component: string): Promise<boolean> {
			return renderer.ssrEnabled(component, requestContext);
		},
		sharedKeys(): string[] {
			return Object.keys(shared);
		},
		clearHistory(): void {
			shouldClearHistory = true;
			// The usual caller redirects next, and a redirect carries no page:
			// the session is what gets the instruction to the page after it.
			session?.put(CLEAR_HISTORY_SESSION_KEY, true);
		},
		encryptHistory(encrypt = true): void {
			shouldEncryptHistory = encrypt;
		},
		flash(provider: () => unknown): void {
			flashProvider = provider;
		},
		resolvePageFlags,
		requestInfo(): PhotonRequestInfo {
			return info;
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
			const pageProps = { ...shared, ...props };
			const sharedKeys = Object.keys(shared);
			if (!info.isPhotonRequest) {
				return renderer.render(
					component,
					pageProps,
					url,
					finalMeta,
					await resolvePageFlags(),
					sharedKeys,
					requestContext,
				);
			}
			// A props request is answered from this one resolution, against the
			// partial request: no SSR, no HTML document, and a resolver the
			// reload did not ask for never runs.
			const resolved = await resolveProps(pageProps, component, info.partial);
			const result = renderer.renderProps(
				component,
				resolved.props,
				url,
				finalMeta,
				{
					...resolved.extras,
					...(sharedKeys.length > 0 ? { sharedProps: sharedKeys } : {}),
					...(await resolvePageFlags()),
				},
			);
			stampResponse(requestContext, result.headers);
			return result;
		},
	};
}

/** The session key a pending `clearHistory()` waits under across a redirect. */
const CLEAR_HISTORY_SESSION_KEY = "photon.clear_history";

/** The part of a session store `clearHistory()` needs. */
interface HistorySession {
	put(key: string, value: unknown): void;
	has(key: string): boolean;
	pull(key: string, fallback: unknown): unknown;
}

/** The request's session, when the host has one (duck-typed, like the flash bag). */
function historySessionOf(ctx: unknown): HistorySession | undefined {
	const session = Reflect.get(Object(ctx), "session");
	if (typeof session !== "object" || session === null) return undefined;
	const put = Reflect.get(session, "put");
	const has = Reflect.get(session, "has");
	const pull = Reflect.get(session, "pull");
	if (
		typeof put !== "function" ||
		typeof has !== "function" ||
		typeof pull !== "function"
	) {
		return undefined;
	}
	return {
		put: (key, value) => {
			Reflect.apply(put, session, [key, value]);
		},
		has: (key) => Reflect.apply(has, session, [key]) === true,
		pull: (key, fallback) => Reflect.apply(pull, session, [key, fallback]),
	};
}

/**
 * Put a props response's headers on the host response, as upstream sets
 * `X-Inertia` itself: a handler that sends only the body still answers JSON,
 * not a string the host would label `text/plain`.
 */
function stampResponse(
	requestContext: SsrRequestContext | undefined,
	headers: Readonly<Record<string, string>>,
): void {
	const res = Reflect.get(Object(requestContext), "response");
	if (typeof res !== "object" || res === null) return;
	const header = Reflect.get(res, "header");
	if (typeof header !== "function") return;
	for (const [name, value] of Object.entries(headers)) {
		header.call(res, name, value);
	}
}
