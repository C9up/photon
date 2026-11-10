/**
 * What the Photon protocol headers say about the request being served.
 *
 * Read once, before the handler runs, so `render()` already knows whether it
 * is answering a page load or a props request — the page object is then built
 * a single time, against the right request.
 */

import type { PropsRequest } from "./props.js";

/** The request, as the protocol headers describe it. */
export interface PhotonRequestInfo {
	/** The client router asked for the page object (`x-photon: true`). */
	readonly isPhotonRequest: boolean;
	/**
	 * The asset version the client was served with. Absent means the client
	 * does not speak versioning, not "version empty".
	 */
	readonly version?: string;
	/** The request method, upper-cased. */
	readonly method: string;
	/** Scopes the validation errors to one form. */
	readonly errorBag?: string;
	/** The partial-reload instructions, applied by the props resolver. */
	readonly partial: PropsRequest;
}

/** A request header, however the host exposes it. */
export function readRequestHeader(
	ctx: unknown,
	name: string,
): string | undefined {
	const req = Reflect.get(Object(ctx), "request");
	if (typeof req !== "object" || req === null) return undefined;
	const viaMethod = Reflect.get(req, "header");
	if (typeof viaMethod === "function") {
		const value = viaMethod.call(req, name);
		return typeof value === "string" ? value : undefined;
	}
	const bag = Reflect.get(req, "headers");
	const value =
		typeof bag === "object" && bag !== null
			? Reflect.get(bag, name)
			: undefined;
	return typeof value === "string" ? value : undefined;
}

/** The request method, however the host exposes it. */
export function readRequestMethod(ctx: unknown): string {
	const req = Reflect.get(Object(ctx), "request");
	const viaMethod = Reflect.get(Object(req), "method");
	if (typeof viaMethod === "function") {
		const value = viaMethod.call(req);
		return typeof value === "string" ? value.toUpperCase() : "GET";
	}
	return typeof viaMethod === "string" ? viaMethod.toUpperCase() : "GET";
}

/**
 * The URL the client is on, query string included — upstream's
 * `request.url(true)`.
 *
 * The page's `url` is what the client writes to the address bar, and the
 * stale-version reload goes back to it: without the query, `/users?page=2`
 * became `/users` on every visit. A Node-style `url` string already carries
 * the query; `path()` is the last resort.
 */
export function readRequestUrl(ctx: unknown): string {
	const req = Reflect.get(Object(ctx), "request");
	if (typeof req !== "object" || req === null) return "/";
	const url = Reflect.get(req, "url");
	if (typeof url === "function") {
		const value = url.call(req, true);
		if (typeof value === "string" && value !== "") return value;
	} else if (typeof url === "string" && url !== "") {
		return url;
	}
	const pathname = Reflect.get(req, "path");
	if (typeof pathname === "function") {
		const value = pathname.call(req);
		if (typeof value === "string" && value !== "") return value;
	} else if (typeof pathname === "string" && pathname !== "") {
		return pathname;
	}
	return "/";
}

/** A comma-separated header list, trimmed and without empties. */
function splitHeaderList(raw: string | undefined): string[] {
	if (raw === undefined || raw.trim() === "") return [];
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/** Read the protocol headers of a request. */
export function readRequestInfo(ctx: unknown): PhotonRequestInfo {
	const header = (name: string): string | undefined =>
		readRequestHeader(ctx, name);
	const version = header("x-photon-version");
	const errorBag = header("x-photon-error-bag");
	return {
		isPhotonRequest: header("x-photon") === "true",
		method: readRequestMethod(ctx),
		...(version === undefined ? {} : { version }),
		...(errorBag === undefined || errorBag === "" ? {} : { errorBag }),
		partial: {
			only: splitHeaderList(header("x-photon-partial-data")),
			except: splitHeaderList(header("x-photon-partial-except")),
			component: header("x-photon-partial-component"),
			// `reset` says "replace these, do not merge them" — the client
			// clearing a list before loading its first page again.
			reset: splitHeaderList(header("x-photon-reset")),
			// Once-keys the client still holds: those props are not resolved.
			exceptOnce: splitHeaderList(header("x-photon-except-once-props")),
			// Which way a scroll prop's new page joins the rows already shown.
			mergeIntent:
				header("x-photon-infinite-scroll-merge-intent") === "prepend"
					? "prepend"
					: "append",
		},
	};
}

/**
 * Whether this request must be answered with a hard reload because the
 * client's assets are stale.
 *
 * Only a GET: replaying a mutation would be worse than a stale page. And only
 * a client that sent a version — AdonisJS never meets an absent one because
 * its client always sends it, but ours predates the header, and forcing a
 * reload on every such request would break them all.
 */
export function shouldReloadForAssetVersion(
	info: PhotonRequestInfo,
	serverVersion: string,
): boolean {
	return (
		info.isPhotonRequest &&
		info.method === "GET" &&
		info.version !== undefined &&
		info.version !== serverVersion
	);
}
