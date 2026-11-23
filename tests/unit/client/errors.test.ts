import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors } from "../../../src/client/hydrate.js";
import {
	PHOTON_DOCS_BASE_URL,
	photonClientErrorClass,
} from "../../../src/client/photonClientError.js";

describe("photon > client errors", () => {
	it("are exported by the client entry as flare exceptions", () => {
		const err = new errors.E_PHOTON_HYDRATION_NO_DATA("boom");
		expect(err).toBeInstanceOf(Exception);
		expect(err).toMatchObject({
			code: "E_PHOTON_HYDRATION_NO_DATA",
			status: 500,
		});
	});

	it("computes docsUrl from the lowercased, hyphen-separated code", () => {
		const err = new errors.E_PHOTON_HYDRATION_NO_DATA("boom");
		expect(err.docsUrl).toBe(
			`${PHOTON_DOCS_BASE_URL}/en/reference/errors#e-photon-hydration-no-data`,
		);
	});

	it("preserves a context payload as a readonly property", () => {
		const err = new errors.E_PHOTON_HYDRATION_BAD_DATA("malformed", {
			context: { selector: "#app", rawLength: 0 },
		});
		expect(err.context).toEqual({ selector: "#app", rawLength: 0 });
	});

	it("forwards `cause` to Error so devtools chains the underlying error", () => {
		const inner = new SyntaxError("Unexpected token");
		const err = new errors.E_PHOTON_HYDRATION_BAD_DATA("JSON parse failed", {
			cause: inner,
		});
		expect(err.cause).toBe(inner);
	});

	it("emits name + code + message + docsUrl through JSON.stringify (log-shipping contract)", () => {
		const err = new errors.E_PHOTON_HYDRATION_ADAPTER_LOAD_FAILED(
			"adapter boom",
			{ help: "install react-dom" },
		);
		const serialized: unknown = JSON.parse(JSON.stringify(err));
		expect(serialized).toMatchObject({
			name: "E_PHOTON_HYDRATION_ADAPTER_LOAD_FAILED",
			code: "E_PHOTON_HYDRATION_ADAPTER_LOAD_FAILED",
			message: "adapter boom",
			docsUrl: `${PHOTON_DOCS_BASE_URL}/en/reference/errors#e-photon-hydration-adapter-load-failed`,
			help: "install react-dom",
		});
	});

	it("walks the cause chain when toJSON() runs", () => {
		const inner = new SyntaxError("Unexpected token <");
		const err = new errors.E_PHOTON_HYDRATION_BAD_DATA("JSON parse failed", {
			cause: inner,
		});
		const serialized: unknown = JSON.parse(JSON.stringify(err));
		expect(serialized).toMatchObject({
			code: "E_PHOTON_HYDRATION_BAD_DATA",
			message: "JSON parse failed",
			cause: { name: "SyntaxError", message: "Unexpected token <" },
		});
	});

	it("rejects unknown codes at compile time (literal-union narrowing)", () => {
		// @ts-expect-error — "PHOTON_BOGUS" is not in PhotonClientErrorCode.
		photonClientErrorClass("PHOTON_BOGUS");
	});
});
