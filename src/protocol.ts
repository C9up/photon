/**
 * The protocol's server half, usable without photon's renderer.
 *
 * photon's own middleware and renderer go through these, and so can another
 * renderer that writes its own document — aurora answers its page visits with
 * them — so the protocol has one implementation: how a page object is built
 * (props resolved, extras, JSON as the client receives it), and what a visit
 * gets instead of a page (a 409 to reload, a 303 after a mutation).
 */

import type { PageFlags, PageProps } from "./PhotonRenderer.js";
import { type PropsRequest, type RescuedError, resolveProps } from "./props.js";
import {
	type PhotonRequestInfo,
	shouldReloadForAssetVersion,
} from "./requestInfo.js";
import { readResponseHeader } from "./requestSecurity.js";

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
function readStatus(res: object): number | undefined {
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
	res: object,
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
	Reflect.set(res, "status", status);
	const existing = Reflect.get(res, "headers");
	Reflect.set(res, "headers", {
		...(typeof existing === "object" && existing !== null ? existing : {}),
		...headers,
	});
	Reflect.set(res, "body", body);
}

/**
 * Add X-Photon to the response's Vary header.
 *
 * The same URL answers with a page or with its props depending on X-Photon, so
 * a cache that ignores the header can hand the JSON to a browser loading the
 * page, or the page to the client router. Every response, as upstream's
 * middleware does: whether a later handler renders is not known yet.
 */
export function varyOnPhoton(res: object): void {
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
	Reflect.set(res, "headers", {
		...(typeof existing === "object" && existing !== null ? existing : {}),
		vary: value,
	});
}

export interface PageObjectOptions {
	/** The URL the page is at (the request's path and query). */
	url: string;
	/** The asset version the client echoes back; a mismatch reloads it. */
	version: string;
	/** The adapter that mounts it on the client. */
	framework: string;
	/** A partial reload's request (`readRequestInfo(ctx).partial`), if any. */
	partial?: PropsRequest;
	/** The keys shared props contributed. */
	sharedKeys?: readonly string[];
	flags?: PageFlags;
}

/**
 * The page object for `component`: props resolved (deferred, optional, merge,
 * once… as the request asks), the protocol extras beside them, everything as
 * the client receives it through JSON. Rescued deferred-prop errors come back
 * for the caller to report.
 */
export async function buildPageObject(
	component: string,
	props: Record<string, unknown>,
	options: PageObjectOptions,
): Promise<{ page: PageProps; rescuedErrors: readonly RescuedError[] }> {
	const resolved = await resolveProps(props, component, options.partial);
	const flags = options.flags ?? {};
	const sharedKeys = options.sharedKeys ?? [];
	const serialisedProps = toJson(resolved.props);
	const page: PageProps = {
		component,
		props: isJsonObject(serialisedProps) ? serialisedProps : {},
		url: options.url,
		framework: options.framework,
		version: options.version,
		...(sharedKeys.length > 0 ? { sharedProps: [...sharedKeys] } : {}),
		...resolved.extras,
		...flags,
		...(flags.flash === undefined ? {} : { flash: toJson(flags.flash) }),
	};
	return { page, rescuedErrors: resolved.rescuedErrors };
}

/**
 * After the handler ran: what a request gets instead of the page, when it
 * should. Returns whether it wrote the response.
 *
 * - a plain browser load asked to go elsewhere (`location`) gets a 302;
 * - a visit asked to go elsewhere, or made with a stale asset version, gets a
 *   409 with `x-photon-location`, which the client follows with a full load;
 * - a visit whose PUT / PATCH / DELETE was redirected gets a 303, so the next
 *   hop is the GET the client expects (a 302 repeats the method).
 */
export function finishVisit(
	ctx: unknown,
	res: object,
	info: PhotonRequestInfo,
	options: { url: string; version: string; location?: string | undefined },
): boolean {
	const explicit = options.location;
	// NAMED DEVIATION: upstream answers `location()` with a 409 whatever the
	// request. A plain browser load has no client router to read it and shows
	// an empty error page; a 302 sends that browser on itself.
	if (!info.isPhotonRequest) {
		if (explicit === undefined) return false;
		writeResponse(res, 302, { location: explicit });
		return true;
	}
	// An explicit location wins; otherwise a stale asset version forces a hard
	// reload of the SAME url so the client picks up the new bundles.
	const stale =
		explicit === undefined &&
		shouldReloadForAssetVersion(info, options.version);
	const target = explicit ?? (stale ? options.url : undefined);
	// The flash messages this request consumed must survive the hard reload,
	// or a "Saved" landing right after a deploy is never shown.
	if (stale) reflashSession(ctx);
	if (target !== undefined) {
		writeResponse(res, 409, {
			"x-photon-location": target,
			"x-photon-version": options.version,
		});
		return true;
	}
	const setStatus = Reflect.get(res, "status");
	if (
		MUTATION_METHODS.has(info.method) &&
		readStatus(res) === 302 &&
		typeof setStatus === "function"
	) {
		setStatus.call(res, 303);
	}
	return false;
}

/** A value as the client receives it: through JSON, `toJSON()` and all. */
function toJson(value: unknown): unknown {
	const text = JSON.stringify(value);
	return text === undefined ? undefined : JSON.parse(text);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
