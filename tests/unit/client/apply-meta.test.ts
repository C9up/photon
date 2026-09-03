/**
 * Unit suite for applyMetaToDom — verifies SPA-side `<head>` mutation:
 * title swap, owned-tag upserts (description / canonical / robots / keywords
 * / OG / Twitter / custom), idempotent re-apply, and Photon-owned cleanup
 * when the destination payload sheds tags.
 *
 * Runs under jsdom (vitest environment) so the real DOM contract is exercised.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMetaToDom } from "../../../src/client/applyMeta.js";
import type { MetaTags } from "../../../src/seo/Meta.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}




const OWNED_ATTR = "data-photon-meta";

describe("photon > applyMetaToDom", () => {
	beforeEach(() => {
		document.head.innerHTML = "";
		document.title = "initial";
	});

	afterEach(() => {
		document.head.innerHTML = "";
	});

	it("undefined meta restores the captured initial title and clears owned nodes", () => {
		document.title = "page A";
		const owned = document.createElement("meta");
		owned.setAttribute("name", "description");
		owned.setAttribute("content", "stale");
		owned.setAttribute(OWNED_ATTR, "1");
		document.head.appendChild(owned);

		applyMetaToDom(undefined);

		expect(document.head.querySelectorAll(`[${OWNED_ATTR}]`)).toHaveLength(0);
	});

	it("upserts description, canonical, robots, keywords from a basic meta payload", () => {
		const meta: MetaTags = {
			title: "About",
			description: "About page",
			canonical: "https://example.test/about",
			robots: "index,follow",
			keywords: ["foo", "bar"],
		};
		applyMetaToDom(meta);

		expect(document.title).toBe("About");
		const desc = document.head.querySelector(
			`meta[name="description"][${OWNED_ATTR}]`,
		);
		expect(desc?.getAttribute("content")).toBe("About page");

		const canonical = document.head.querySelector(
			`link[rel="canonical"][${OWNED_ATTR}]`,
		);
		expect(canonical?.getAttribute("href")).toBe("https://example.test/about");

		const robots = document.head.querySelector(
			`meta[name="robots"][${OWNED_ATTR}]`,
		);
		expect(robots?.getAttribute("content")).toBe("index,follow");

		const keywords = document.head.querySelector(
			`meta[name="keywords"][${OWNED_ATTR}]`,
		);
		expect(keywords?.getAttribute("content")).toBe("foo, bar");
	});

	it("emits og:* meta tags with property attribute", () => {
		applyMetaToDom({
			og: {
				title: "OG Title",
				description: "OG Desc",
				image: "https://cdn.test/img.png",
				imageAlt: "alt",
				url: "https://example.test/p",
				type: "article",
				siteName: "Example",
				locale: "fr_FR",
			},
		});

		const tags = Array.from(
			document.head.querySelectorAll(`meta[property^="og:"][${OWNED_ATTR}]`),
		).map((el) => [el.getAttribute("property"), el.getAttribute("content")]);

		expect(tags).toEqual(
			expect.arrayContaining([
				["og:title", "OG Title"],
				["og:description", "OG Desc"],
				["og:image", "https://cdn.test/img.png"],
				["og:image:alt", "alt"],
				["og:url", "https://example.test/p"],
				["og:type", "article"],
				["og:site_name", "Example"],
				["og:locale", "fr_FR"],
			]),
		);
	});

	it("emits twitter:* meta tags with name attribute", () => {
		applyMetaToDom({
			twitter: {
				card: "summary_large_image",
				site: "@example",
				creator: "@author",
				title: "T Title",
				description: "T Desc",
				image: "https://cdn.test/t.png",
				imageAlt: "t alt",
			},
		});

		const tags = Array.from(
			document.head.querySelectorAll(`meta[name^="twitter:"][${OWNED_ATTR}]`),
		).map((el) => [el.getAttribute("name"), el.getAttribute("content")]);

		expect(tags).toEqual(
			expect.arrayContaining([
				["twitter:card", "summary_large_image"],
				["twitter:site", "@example"],
				["twitter:creator", "@author"],
				["twitter:title", "T Title"],
				["twitter:description", "T Desc"],
				["twitter:image", "https://cdn.test/t.png"],
				["twitter:image:alt", "t alt"],
			]),
		);
	});

	it("emits custom meta entries with name / property / http-equiv / charset", () => {
		applyMetaToDom({
			custom: [
				{ name: "theme-color", content: "#abcdef" },
				{ property: "fb:app_id", content: "123" },
				{ httpEquiv: "refresh", content: "30" },
				{ charset: "utf-8" },
			],
		});

		const customs = Array.from(
			document.head.querySelectorAll(`meta[${OWNED_ATTR}]`),
		);
		expect(customs).toHaveLength(4);
		expect(defined(customs[0]).getAttribute("name")).toBe("theme-color");
		expect(defined(customs[1]).getAttribute("property")).toBe("fb:app_id");
		expect(defined(customs[2]).getAttribute("http-equiv")).toBe("refresh");
		expect(defined(customs[3]).getAttribute("charset")).toBe("utf-8");
	});

	it("is idempotent — re-applying the same payload converges on the same DOM", () => {
		const meta: MetaTags = {
			title: "Stable",
			description: "Stable desc",
			og: { title: "OG Stable" },
		};
		applyMetaToDom(meta);
		const first = document.head.innerHTML;
		applyMetaToDom(meta);
		expect(document.head.innerHTML).toBe(first);
	});

	it("removes previously-owned tags that the new payload no longer carries", () => {
		applyMetaToDom({
			title: "rich",
			description: "rich desc",
			og: { title: "rich og" },
		});
		expect(
			document.head.querySelectorAll(`[${OWNED_ATTR}]`).length,
		).toBeGreaterThan(1);

		applyMetaToDom({ title: "poor" });
		// Only the title changed; all OG / description tags are gone.
		expect(document.head.querySelectorAll(`[${OWNED_ATTR}]`)).toHaveLength(0);
		expect(document.title).toBe("poor");
	});

	it("leaves pre-existing non-owned <head> nodes untouched", () => {
		const userTag = document.createElement("meta");
		userTag.setAttribute("name", "color-scheme");
		userTag.setAttribute("content", "dark");
		document.head.appendChild(userTag);

		applyMetaToDom({ title: "spa nav", description: "x" });

		// Photon must not touch the user-authored tag.
		expect(
			document.head.querySelector('meta[name="color-scheme"]'),
		).not.toBeNull();
		expect(
			document.head.querySelector(`meta[name="description"][${OWNED_ATTR}]`),
		).not.toBeNull();
	});

	it("skips fields when their content is undefined", () => {
		applyMetaToDom({
			og: { title: undefined, description: "only-desc" },
			twitter: { card: "summary", title: undefined },
		});

		// `og:title` should NOT be present (undefined skipped).
		expect(document.head.querySelector(`meta[property="og:title"]`)).toBeNull();
		expect(
			document.head
				.querySelector(`meta[property="og:description"]`)
				?.getAttribute("content"),
		).toBe("only-desc");
		expect(
			document.head.querySelector(`meta[name="twitter:title"]`),
		).toBeNull();
	});

	it("skips empty keywords array (no <meta name=keywords> emitted)", () => {
		applyMetaToDom({ title: "t", keywords: [] });
		expect(document.head.querySelector(`meta[name="keywords"]`)).toBeNull();
	});
});
