/**
 * What Photon's browser-side errors share (the classes are in `errors.ts`).
 * Mirrors the server-side `../photonError.ts` but lives apart, so the server
 * module never lands in the browser bundle. Browser-only — no `node:` imports.
 */

import { Exception } from "@c9up/flare";

/** Every browser-side error code Photon can throw. */
export type PhotonClientErrorCode =
	| "E_PHOTON_HYDRATION_NO_DATA"
	| "E_PHOTON_HYDRATION_BAD_DATA"
	| "E_PHOTON_HYDRATION_NO_TARGET"
	| "E_PHOTON_HYDRATION_UNSUPPORTED_FRAMEWORK"
	| "E_PHOTON_HYDRATION_ADAPTER_LOAD_FAILED"
	| "E_PHOTON_UNKNOWN_ROUTE"
	| "E_PHOTON_MISSING_ROUTE_PARAMS"
	| "E_PHOTON_UNKNOWN_PAGE"
	| "E_PHOTON_INVALID_PAGE_MODULE"
	| "E_PHOTON_INVALID_PAGE_RESPONSE"
	| "E_PHOTON_NO_ROUTER_HOST"
	| "E_PHOTON_NO_PAGE"
	| "E_PHOTON_UNKNOWN_SCROLL_PROP"
	| "E_PHOTON_INVALID_DEFERRED"
	| "E_PHOTON_DEFERRED_PROPS_MISSING"
	| "E_PHOTON_FORM_DATA_MISSING"
	| "E_PHOTON_FORM_DEFAULTS_UNSUPPORTED"
	| "E_PHOTON_INVALID_SVELTE_ROOT"
	| "E_PHOTON_INVALID_SSR_SETUP";

/**
 * Base URL for the Photon error catalog. See the JSDoc on `PHOTON_DOCS_BASE_URL`
 * in `../photonError.ts` for the anchor derivation — kept duplicated here so the
 * browser bundle never imports the server module. The two values MUST stay in
 * sync — `tests/unit/docs-base-url-parity.test.ts` enforces this.
 */
export const PHOTON_DOCS_BASE_URL = "https://reamjs.com";

/** What a throw site passes besides the message. */
export interface PhotonErrorOptions {
	/** How to fix it. */
	help?: string;
	cause?: unknown;
	/** Facts about the failure, kept on the error and in its JSON. */
	context?: Record<string, unknown>;
}

/** What every browser-side Photon error holds. */
export interface PhotonClientError extends Exception {
	readonly code: PhotonClientErrorCode;
	readonly context?: Record<string, unknown>;
	readonly docsUrl: string;
	toJSON(): Record<string, unknown>;
}

/** The class of one code. */
export interface PhotonClientErrorClass<
	C extends PhotonClientErrorCode = PhotonClientErrorCode,
> {
	new (
		message: string,
		options?: PhotonErrorOptions,
	): PhotonClientError & { readonly code: C };
	readonly code: C;
}

/** Whether `value` is one of these errors. */
export function isPhotonClientError(
	value: unknown,
): value is PhotonClientError {
	return (
		value instanceof Exception &&
		typeof value.code === "string" &&
		value.code.startsWith("E_PHOTON_") &&
		"docsUrl" in value
	);
}

function codeToAnchor(code: PhotonClientErrorCode): string {
	return code.toLowerCase().replace(/_/g, "-");
}

/**
 * Walk an `Error.cause` chain and produce a JSON-friendly representation.
 * Unknown shapes (non-Error throws like raw strings or plain objects) are
 * preserved as-is so log shippers see exactly what was thrown.
 *
 * Bounded depth — defensive against pathological self-referential causes.
 */
function serializeCause(cause: unknown, depth = 0): unknown {
	if (cause === undefined) return undefined;
	if (depth > 5) return "[Photon: cause chain truncated at depth 5]";
	if (isPhotonClientError(cause)) return cause.toJSON();
	if (cause instanceof Error) {
		return {
			name: cause.name,
			message: cause.message,
			cause: serializeCause(cause.cause, depth + 1),
		};
	}
	return cause;
}

/**
 * The class of `code`, named by it. Every Photon error has the same shape —
 * a message built at the site, plus `help` and `context` — so the classes
 * come from one place.
 */
export function photonClientErrorClass<C extends PhotonClientErrorCode>(
	code: C,
): PhotonClientErrorClass<C> {
	const ErrorClass = class extends Exception implements PhotonClientError {
		static override code = code;
		declare readonly code: C;
		readonly context?: Record<string, unknown>;
		readonly docsUrl: string;

		constructor(message: string, options?: PhotonErrorOptions) {
			super(
				message,
				options?.cause !== undefined ? { cause: options.cause } : undefined,
			);
			if (options?.help !== undefined) this.help = options.help;
			if (options?.context !== undefined) this.context = options.context;
			this.docsUrl = `${PHOTON_DOCS_BASE_URL}/en/reference/errors#${codeToAnchor(code)}`;
		}

		/**
		 * JSON-serializable view of the error — invoked by `JSON.stringify`. Adds
		 * `name` + `message` (which are non-enumerable on `Error` subclasses and
		 * would otherwise be dropped) and walks the `cause` chain so log shippers
		 * see the full failure context without per-pipeline glue.
		 */
		toJSON(): Record<string, unknown> {
			const out: Record<string, unknown> = {
				name: this.name,
				code: this.code,
				message: this.message,
				docsUrl: this.docsUrl,
			};
			if (this.help !== undefined) out.help = this.help;
			if (this.context !== undefined) out.context = this.context;
			const cause = serializeCause(this.cause);
			if (cause !== undefined) out.cause = cause;
			return out;
		}
	};
	Object.defineProperty(ErrorClass, "name", { value: code });
	return ErrorClass;
}
