/**
 * The client reads `meta` out of a payload field by field: the head code
 * calls `keywords.join` and sets attributes from each tag, so a field of the
 * wrong type is dropped rather than trusted.
 */
import { describe, expect, it } from "vitest";
import { readMetaTags } from "../../src/seo/Meta.js";

describe("photon > readMetaTags", () => {
	it("keeps every well-typed field", () => {
		const meta = {
			title: "Home",
			description: "d",
			canonical: "https://app.example/",
			robots: "index",
			keywords: ["a", "b"],
			og: { title: "OG", siteName: "App" },
			twitter: { card: "summary", site: "@app" },
			custom: [{ name: "x", content: "y" }],
			jsonLd: { "@type": "WebPage" },
		};
		expect(readMetaTags(meta)).toEqual(meta);
	});

	it("drops the fields whose type the head code cannot use", () => {
		expect(
			readMetaTags({
				title: 42,
				keywords: "a, b",
				og: { title: { html: "<b>" }, url: "https://app.example/" },
				twitter: { card: "javascript", site: 7 },
				custom: ["<meta>", { name: "ok", content: ["no"] }],
				jsonLd: "not a node",
			}),
		).toEqual({
			og: { url: "https://app.example/" },
			twitter: {},
			custom: [{ name: "ok" }],
		});
	});

	it("reads nothing out of a value that is not an object", () => {
		for (const value of [undefined, null, "title", ["a"]]) {
			expect(readMetaTags(value)).toBeUndefined();
		}
	});
});
