/**
 * What Photon's server-side errors share (the classes are in `errors.ts`):
 * a code from {@link PhotonErrorCode}, an optional `help` and `context`, a
 * `docsUrl` pointing at the code's entry in the error catalog, and a
 * `toJSON()` that keeps all of it, cause chain included, through
 * `JSON.stringify`.
 */

import { Exception } from "@c9up/flare";

/** Every server-side error code Photon can throw. */
export type PhotonErrorCode =
	| "E_PHOTON_INVALID_CONFIG"
	| "E_PHOTON_SSR_LOAD_FAILED"
	| "E_PHOTON_SSR_RENDER_FAILED"
	| "E_PHOTON_MANIFEST_MISSING"
	| "E_PHOTON_MANIFEST_INVALID"
	| "E_PHOTON_MISSING_CONFIG"
	| "E_PHOTON_INVALID_DURATION"
	| "E_PHOTON_SCROLL_CURSOR_UNDERIVABLE";

/**
 * Where the framework's documentation is served. `docsUrl` appends
 * `/en/reference/errors#<anchor>`, the anchor being the code in lower case with
 * `-` for `_` (`E_PHOTON_INVALID_CONFIG` → `#e-photon-invalid-config`), as the
 * error index slugs its headings and as `@c9up/ream` builds its own links.
 *
 * NOTE: `client/photonClientError.ts` redeclares this constant verbatim so the
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

/** What every server-side Photon error holds. */
export interface PhotonError extends Exception {
	readonly code: PhotonErrorCode;
	readonly context?: Record<string, unknown>;
	readonly docsUrl: string;
	toJSON(): Record<string, unknown>;
}

/** The class of one code. */
export interface PhotonErrorClass<C extends PhotonErrorCode = PhotonErrorCode> {
	new (
		message: string,
		options?: PhotonErrorOptions,
	): PhotonError & { readonly code: C };
	readonly code: C;
}

/** Whether `value` is one of these errors. */
export function isPhotonError(value: unknown): value is PhotonError {
	return (
		value instanceof Exception &&
		typeof value.code === "string" &&
		value.code.startsWith("E_PHOTON_") &&
		"docsUrl" in value
	);
}

function codeToAnchor(code: PhotonErrorCode): string {
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
	if (isPhotonError(cause)) return cause.toJSON();
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
export function photonErrorClass<C extends PhotonErrorCode>(
	code: C,
): PhotonErrorClass<C> {
	const ErrorClass = class extends Exception implements PhotonError {
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
