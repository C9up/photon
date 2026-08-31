import { describe, expect, it } from "vitest";
import { PHOTON_DOCS_BASE_URL, PhotonError } from "../../src/errors.js";

describe("PhotonError", () => {
	it("computes docsUrl from the lowercased, hyphen-separated code", () => {
		const err = new PhotonError("E_PHOTON_INVALID_CONFIG", "boom");
		expect(err.docsUrl).toBe(
			`${PHOTON_DOCS_BASE_URL}/errors/#photon-invalid-config`,
		);
	});

	it("preserves a context payload as a readonly property", () => {
		const err = new PhotonError("E_PHOTON_MANIFEST_MISSING", "missing", {
			context: {
				manifestPath: "/app/build/manifest.json",
				buildDir: "/app/build",
			},
		});
		expect(err.context).toEqual({
			manifestPath: "/app/build/manifest.json",
			buildDir: "/app/build",
		});
	});

	it("forwards `cause` to Error so Node prints the underlying error", () => {
		const inner = new Error("inner");
		const err = new PhotonError("E_PHOTON_SSR_LOAD_FAILED", "outer", {
			cause: inner,
		});
		expect(err.cause).toBe(inner);
	});

	it("emits name + code + message + docsUrl through JSON.stringify (log-shipping contract)", () => {
		const err = new PhotonError("E_PHOTON_SSR_RENDER_FAILED", "render boom", {
			hint: "check your component",
			context: { url: "/dashboard" },
		});
		const serialized: unknown = JSON.parse(JSON.stringify(err));
		expect(serialized).toMatchObject({
			name: "PhotonError",
			code: "E_PHOTON_SSR_RENDER_FAILED",
			message: "render boom",
			docsUrl: `${PHOTON_DOCS_BASE_URL}/errors/#photon-ssr-render-failed`,
			hint: "check your component",
			context: { url: "/dashboard" },
		});
	});

	it("walks the cause chain when a wrapper Error is JSON-serialized via toJSON()", () => {
		const inner = new Error("ENOENT: missing file");
		const photonErr = new PhotonError(
			"E_PHOTON_MANIFEST_MISSING",
			"manifest absent",
			{ cause: inner },
		);
		// Direct stringify includes the cause walk.
		const serialized: unknown = JSON.parse(JSON.stringify(photonErr));
		expect(serialized).toMatchObject({
			code: "E_PHOTON_MANIFEST_MISSING",
			message: "manifest absent",
			cause: { name: "Error", message: "ENOENT: missing file" },
		});
	});

	it("rejects unknown codes at compile time (literal-union narrowing)", () => {
		// @ts-expect-error — "PHOTON_BOGUS" is not in PhotonErrorCode.
		// The compile-time error IS the assertion; vitest's typecheck mode
		// surfaces the missing-error as a test failure if the union widens.
		new PhotonError("PHOTON_BOGUS", "boom");
	});
});
