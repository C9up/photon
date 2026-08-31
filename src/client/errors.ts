/**
 * PhotonClientError — typed error for the browser-side hydration / SPA-nav surface.
 *
 * Mirrors the server-side `PhotonError` shape (from `../errors.ts`) but lives in
 * a separate module so the server-side error class never accidentally lands in
 * the browser bundle (the server file imports nothing browser-incompatible
 * today, but keeping the boundary clean future-proofs against accidents).
 *
 * Browser-only — no `node:` imports.
 */

export type PhotonClientErrorCode =
	| "E_PHOTON_HYDRATION_NO_DATA"
	| "E_PHOTON_HYDRATION_BAD_DATA"
	| "E_PHOTON_HYDRATION_NO_TARGET"
	| "E_PHOTON_HYDRATION_UNSUPPORTED_FRAMEWORK"
	| "E_PHOTON_HYDRATION_ADAPTER_LOAD_FAILED";

/**
 * Base URL for the Photon error catalog. See the JSDoc on `PHOTON_DOCS_BASE_URL`
 * in `../errors.ts` for the slug derivation — kept duplicated here so the
 * browser bundle never imports the server module. The two values MUST stay in
 * sync — `tests/unit/docs-base-url-parity.test.ts` enforces this.
 */
export const PHOTON_DOCS_BASE_URL = "https://ream.dev";

function codeToAnchor(code: PhotonClientErrorCode): string {
	// Kept in step with the server copy in `../errors.ts`: the `E_` prefix
	// belongs to the code, not to the catalog heading it links to.
	return code.replace(/^E_/, "").toLowerCase().replace(/_/g, "-");
}

function serializeCause(cause: unknown, depth = 0): unknown {
	if (cause === undefined) return undefined;
	if (depth > 5) return "[Photon: cause chain truncated at depth 5]";
	if (cause instanceof PhotonClientError) return cause.toJSON();
	if (cause instanceof Error) {
		return {
			name: cause.name,
			message: cause.message,
			cause: serializeCause(cause.cause, depth + 1),
		};
	}
	return cause;
}

export class PhotonClientError extends Error {
	readonly code: PhotonClientErrorCode;
	readonly hint?: string;
	readonly context?: Record<string, unknown>;
	readonly docsUrl: string;

	constructor(
		code: PhotonClientErrorCode,
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
		this.name = "PhotonClientError";
		this.code = code;
		this.hint = options?.hint;
		this.context = options?.context;
		this.docsUrl = `${PHOTON_DOCS_BASE_URL}/errors/#${codeToAnchor(code)}`;
	}

	/**
	 * JSON-serializable view of the error — invoked by `JSON.stringify`. Adds
	 * `name` + `message` (which are non-enumerable on `Error` subclasses) and
	 * walks the `cause` chain so devtools / log shippers see the full failure
	 * context.
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
