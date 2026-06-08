import { describe, expect, it } from "vitest";
import { mergeMeta } from "../../src/seo/Meta.js";

describe("photon > seo > mergeMeta > precedence", () => {
	it("returns an empty object when no layers are provided", () => {
		expect(mergeMeta()).toEqual({});
	});

	it("ignores undefined layers silently", () => {
		expect(mergeMeta(undefined, { title: "X" }, undefined)).toEqual({
			title: "X",
		});
	});

	it("right-most layer wins per scalar leaf", () => {
		const merged = mergeMeta(
			{ title: "Default", description: "Default desc" },
			{ title: "Decorator" },
			{ title: "Imperative" },
		);
		expect(merged.title).toBe("Imperative");
		expect(merged.description).toBe("Default desc"); // un-overridden
	});

	it("`undefined` in a later layer does NOT clear an earlier value", () => {
		const merged = mergeMeta({ title: "A" }, { title: undefined });
		expect(merged.title).toBe("A");
	});

	it("empty-string in a later layer does NOT clobber an earlier real value", () => {
		// Without this guard, a stale '' from a decorator factory would
		// silently erase a defaultMeta-supplied title — the user would see
		// `<title></title>` (or no title) instead of the application default.
		const merged = mergeMeta({ title: "Default" }, { title: "" });
		expect(merged.title).toBe("Default");

		const merged2 = mergeMeta(
			{ description: "Default desc" },
			{ description: "" },
		);
		expect(merged2.description).toBe("Default desc");
	});
});

describe("photon > seo > mergeMeta > og / twitter sub-objects", () => {
	it("og fields merge field-by-field, NOT object-replace", () => {
		const merged = mergeMeta(
			{ og: { title: "OG Title", image: "/a.png", siteName: "Site" } },
			{ og: { title: "Override", description: "OG Desc" } },
		);
		expect(merged.og).toEqual({
			title: "Override",
			image: "/a.png", // preserved from layer 1
			siteName: "Site", // preserved from layer 1
			description: "OG Desc", // added by layer 2
		});
	});

	it("twitter fields merge field-by-field", () => {
		const merged = mergeMeta(
			{ twitter: { card: "summary", site: "@a" } },
			{ twitter: { card: "summary_large_image" } },
		);
		expect(merged.twitter).toEqual({
			card: "summary_large_image",
			site: "@a",
		});
	});
});

describe("photon > seo > mergeMeta > arrays", () => {
	it("keywords concat then de-dup case-insensitively", () => {
		const merged = mergeMeta(
			{ keywords: ["framework", "Node"] },
			{ keywords: ["NODE", "ssr"] },
		);
		// 'Node' (first) kept; 'NODE' (duplicate, case-insensitive) dropped.
		expect(merged.keywords).toEqual(["framework", "Node", "ssr"]);
	});

	it("custom entries dedup by `name||property||httpEquiv||charset` — last wins", () => {
		const merged = mergeMeta(
			{ custom: [{ name: "theme-color", content: "#000" }] },
			{ custom: [{ name: "theme-color", content: "#fff" }] },
		);
		expect(merged.custom).toEqual([{ name: "theme-color", content: "#fff" }]);
	});

	it("custom entries with different keys are kept side-by-side", () => {
		const merged = mergeMeta(
			{ custom: [{ name: "theme-color", content: "#000" }] },
			{ custom: [{ property: "fb:app_id", content: "1" }] },
		);
		expect(merged.custom).toHaveLength(2);
	});

	it("custom entries with no identifying attribute are dropped", () => {
		const merged = mergeMeta({ custom: [{ content: "orphan" }] });
		expect(merged.custom ?? []).toEqual([]);
	});
});
