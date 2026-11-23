/**
 * PhotonError — structured error for the Photon SSR / renderer surface.
 *
 * Mirrors the shape of `PhotonClientError` (browser side, `./client/errors.ts`):
 * narrowed `code` literal union + optional `hint` / `cause` / `context` +
 * a `docsUrl` getter that resolves to the matching anchor in the published
 * error catalog.
 */

/**
 * Every server-side error code Photon can throw. New codes are added here
 * AND in `docs/{en,fr}/errors/index.md` — the integration grep test in
 * `tests/integration/error-catalog.test.ts` enforces source ↔ docs parity.
 */
export type PhotonErrorCode =
	| "E_PHOTON_INVALID_CONFIG"
	| "E_PHOTON_SSR_LOAD_FAILED"
	| "E_PHOTON_SSR_RENDER_FAILED"
	| "E_PHOTON_MANIFEST_MISSING"
	| "E_PHOTON_MANIFEST_INVALID";

/**
 * Where the framework's documentation is served. The `docsUrl` getter appends
 * `/en/reference/errors#<anchor>`, the anchor being the code in lower case with
 * `-` for `_` (`E_PHOTON_INVALID_CONFIG` → `#e-photon-invalid-config`), as the
 * error index slugs its headings and as `@c9up/ream` builds its own links.
 *
 * NOTE: `client/errors.ts` redeclares this constant verbatim so the browser
 * bundle never imports the server module. The two values MUST stay in sync —
 * `tests/unit/docs-base-url-parity.test.ts` enforces this.
 */
export const PHOTON_DOCS_BASE_URL = "https://r-eam.com";

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
	if (cause instanceof PhotonError) return cause.toJSON();
	if (cause instanceof Error) {
		return {
			name: cause.name,
			message: cause.message,
			cause: serializeCause(cause.cause, depth + 1),
		};
	}
	return cause;
}

export class PhotonError extends Error {
	readonly code: PhotonErrorCode;
	readonly hint?: string;
	readonly context?: Record<string, unknown>;
	readonly docsUrl: string;

	constructor(
		code: PhotonErrorCode,
		message: string,
		options?: {
			hint?: string;
			cause?: unknown;
			context?: Record<string, unknown>;
		},
	) {
		super(
			message,
			options?.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.name = "PhotonError";
		this.code = code;
		this.hint = options?.hint;
		this.context = options?.context;
		this.docsUrl = `${PHOTON_DOCS_BASE_URL}/en/reference/errors#${codeToAnchor(code)}`;
	}

	/**
	 * JSON-serializable view of the error — invoked by `JSON.stringify`. Adds
	 * `name` + `message` (which are non-enumerable on `Error` subclasses and
	 * would otherwise be dropped) and walks the `cause` chain so log shippers
	 * see the full failure context without per-pipeline glue. Adonis's
	 * `Exception` follows the same self-describing-on-serialize pattern.
	 */
	toJSON(): Record<string, unknown> {
		const out: Record<string, unknown> = {
			name: this.name,
			code: this.code,
			message: this.message,
			docsUrl: this.docsUrl,
		};
		if (this.hint !== undefined) out.hint = this.hint;
		if (this.context !== undefined) out.context = this.context;
		const cause = serializeCause(this.cause);
		if (cause !== undefined) out.cause = cause;
		return out;
	}
}
