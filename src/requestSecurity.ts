/**
 * What a page needs to know about the security layer in front of it.
 *
 * The protective headers and the CSP nonce belong to that layer (blackhole in
 * a Ream app). Photon only reads them, so its pages keep the policy the
 * application configured.
 */

/**
 * The request-store key a security layer sets to say it decided the protective
 * headers — blackhole puts the set it applied there, an empty one included.
 */
const SECURITY_HEADERS_KEY = "securityHeaders";

/** The headers that answer the same protection as a fallback header. */
const SAME_PROTECTION: Readonly<Record<string, readonly string[]>> = {
	// A report-only policy is the layer's choice of CSP mode; an enforced one
	// added beside it would block what it only meant to report.
	"content-security-policy": [
		"content-security-policy",
		"content-security-policy-report-only",
	],
};

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
 * Which of Photon's fallback headers this response still needs.
 *
 * A layer that decided the protective headers says so in the request store,
 * and may have left one out on purpose (a `frameOptions: false`): Photon adds
 * none then. Otherwise each protection is answered on its own — a header the
 * response carries is kept, a missing one is filled — because one header set
 * by someone says nothing about the others.
 */
export function missingSecurityHeaders(
	ctx: object | undefined,
	fallback: Readonly<Record<string, string>>,
): Record<string, string> {
	const store = ctx === undefined ? undefined : Reflect.get(ctx, "store");
	if (store instanceof Map && store.has(SECURITY_HEADERS_KEY)) return {};
	const res = ctx === undefined ? undefined : Reflect.get(ctx, "response");
	const present = (name: string): boolean =>
		typeof res === "object" &&
		res !== null &&
		readResponseHeader(res, name) !== undefined;
	const missing: Record<string, string> = {};
	for (const [name, value] of Object.entries(fallback)) {
		const answeredBy = SAME_PROTECTION[name] ?? [name];
		if (!answeredBy.some(present)) missing[name] = value;
	}
	return missing;
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
