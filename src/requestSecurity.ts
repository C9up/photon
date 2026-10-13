/**
 * What a page needs to know about the security layer in front of it.
 *
 * The protective headers and the CSP nonce belong to that layer (blackhole in
 * a Ream app). Photon only reads them, so its pages keep the policy the
 * application configured.
 */

/** The protective headers Photon falls back to when nothing else set them. */
const SECURITY_HEADERS = [
	"content-security-policy",
	"content-security-policy-report-only",
	"x-frame-options",
	"x-content-type-options",
];

/** A response header, however the host exposes it. */
export function readResponseHeader(
	res: object,
	name: string,
): string | undefined {
	const getter = Reflect.get(res, "getHeader");
	if (typeof getter === "function") {
		const value = getter.call(res, name);
		return typeof value === "string" ? value : undefined;
	}
	const bag = Reflect.get(res, "headers");
	const value =
		typeof bag === "object" && bag !== null
			? Reflect.get(bag, name)
			: undefined;
	return typeof value === "string" ? value : undefined;
}

/**
 * Whether a security layer already protected this response.
 *
 * Any one of the headers is the sign: a layer that sets some of them and
 * leaves the others out (a `frameOptions: false`, a `noSniff: false`) chose
 * to, and Photon adding them back would undo that choice.
 */
export function isProtectedElsewhere(ctx: object | undefined): boolean {
	const res = ctx === undefined ? undefined : Reflect.get(ctx, "response");
	if (typeof res !== "object" || res === null) return false;
	return SECURITY_HEADERS.some(
		(name) => readResponseHeader(res, name) !== undefined,
	);
}

/**
 * This request's CSP nonce, or `undefined` when there is none.
 *
 * `response.nonce` first (what blackhole seeds), then the `cspNonce` a
 * middleware may have left in the per-request store. Never generated here: a
 * nonce Photon invented would not appear in the policy, so it would block the
 * page rather than let it run.
 */
export function resolveNonce(ctx: object | undefined): string | undefined {
	if (ctx === undefined) return undefined;
	const res = Reflect.get(ctx, "response");
	const fromResponse =
		typeof res === "object" && res !== null
			? Reflect.get(res, "nonce")
			: undefined;
	if (typeof fromResponse === "string" && fromResponse.length > 0)
		return fromResponse;
	const store = Reflect.get(ctx, "store");
	const fromStore = store instanceof Map ? store.get("cspNonce") : undefined;
	if (typeof fromStore === "string" && fromStore.length > 0) return fromStore;
	return undefined;
}
