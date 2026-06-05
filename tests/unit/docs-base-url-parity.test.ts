import { describe, expect, it } from "vitest";
import { PHOTON_DOCS_BASE_URL as CLIENT_BASE_URL } from "../../src/client/errors.js";
import { PHOTON_DOCS_BASE_URL as SERVER_BASE_URL } from "../../src/errors.js";

/**
 * `PHOTON_DOCS_BASE_URL` is duplicated by design — the browser bundle never
 * imports the server module (which carries `node:` imports through its own
 * call sites). The duplication is documented in both files' JSDoc; this
 * parity test is the contract that prevents silent drift if someone updates
 * one (e.g. moving to `https://docs.ream.dev`) and forgets the other.
 */
describe("photon > PHOTON_DOCS_BASE_URL parity", () => {
	it("server and client constants are identical", () => {
		expect(SERVER_BASE_URL).toBe(CLIENT_BASE_URL);
	});

	it("the constant points at an https URL with no trailing slash", () => {
		expect(SERVER_BASE_URL).toMatch(/^https:\/\/[^\s]+$/);
		expect(SERVER_BASE_URL.endsWith("/")).toBe(false);
	});
});
