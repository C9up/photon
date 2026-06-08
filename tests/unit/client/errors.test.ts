import { describe, expect, it } from "vitest";
import {
	PHOTON_DOCS_BASE_URL,
	PhotonClientError,
} from "../../../src/client/errors.js";

describe("PhotonClientError", () => {
	it("computes docsUrl from the lowercased, hyphen-separated code", () => {
		const err = new PhotonClientError("PHOTON_HYDRATION_NO_DATA", "boom");
		expect(err.docsUrl).toBe(
			`${PHOTON_DOCS_BASE_URL}/errors/#photon-hydration-no-data`,
		);
	});

	it("preserves a context payload as a readonly property", () => {
		const err = new PhotonClientError(
			"PHOTON_HYDRATION_BAD_DATA",
			"malformed",
			{ context: { selector: "#app", rawLength: 0 } },
		);
		expect(err.context).toEqual({ selector: "#app", rawLength: 0 });
	});

	it("forwards `cause` to Error so devtools chains the underlying error", () => {
		const inner = new SyntaxError("Unexpected token");
		const err = new PhotonClientError(
			"PHOTON_HYDRATION_BAD_DATA",
			"JSON parse failed",
			{ cause: inner },
		);
		expect(err.cause).toBe(inner);
	});

	it("emits name + code + message + docsUrl through JSON.stringify (log-shipping contract)", () => {
		const err = new PhotonClientError(
			"PHOTON_HYDRATION_ADAPTER_LOAD_FAILED",
			"adapter boom",
			{ hint: "install react-dom" },
		);
		const serialized: unknown = JSON.parse(JSON.stringify(err));
		expect(serialized).toMatchObject({
			name: "PhotonClientError",
			code: "PHOTON_HYDRATION_ADAPTER_LOAD_FAILED",
			message: "adapter boom",
			docsUrl: `${PHOTON_DOCS_BASE_URL}/errors/#photon-hydration-adapter-load-failed`,
			hint: "install react-dom",
		});
	});

	it("walks the cause chain when toJSON() runs", () => {
		const inner = new SyntaxError("Unexpected token <");
		const err = new PhotonClientError(
			"PHOTON_HYDRATION_BAD_DATA",
			"JSON parse failed",
			{ cause: inner },
		);
		const serialized: unknown = JSON.parse(JSON.stringify(err));
		expect(serialized).toMatchObject({
			code: "PHOTON_HYDRATION_BAD_DATA",
			message: "JSON parse failed",
			cause: { name: "SyntaxError", message: "Unexpected token <" },
		});
	});

	it("rejects unknown codes at compile time (literal-union narrowing)", () => {
		// @ts-expect-error — "PHOTON_BOGUS" is not in PhotonClientErrorCode.
		new PhotonClientError("PHOTON_BOGUS", "boom");
	});
});
