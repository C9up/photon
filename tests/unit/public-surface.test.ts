/**
 * The package entry must re-export every prop helper.
 *
 * A helper that exists but is not exported is invisible to a consumer — the
 * failure looks like "photon has no `defer`", which is exactly the kind of
 * silent hole an import-only migration cannot survive. This test caught one.
 */
import { describe, expect, it } from "vitest";
import * as entry from "../../src/index.js";
import * as props from "../../src/props.js";

describe("photon > public surface", () => {
	it("re-exports every runtime prop helper from the entry point", () => {
		const missing = Object.keys(props).filter((name) => !(name in entry));
		expect(missing).toEqual([]);
	});

	it("exposes the helpers a migrated controller writes", () => {
		for (const name of [
			"always",
			"optional",
			"defer",
			"merge",
			"deepMerge",
			"once",
			"scroll",
		]) {
			expect(typeof Reflect.get(entry, name)).toBe("function");
		}
	});
});
