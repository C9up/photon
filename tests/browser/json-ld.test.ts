import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhotonPageData } from "../../src/client/hydrate.js";
import { bootRouter, router } from "../../src/client/router.js";
import { serializeMetaTags } from "../../src/seo/Meta.js";

/**
 * The page's JSON-LD across SPA navigations, in Chromium with the real
 * router: the server writes page A's; each navigation replaces it with the
 * next page's, and a page without any leaves none behind.
 */

afterEach(() => {
	vi.unstubAllGlobals();
	for (const script of document.head.querySelectorAll("[data-photon-meta]")) {
		script.remove();
	}
	history.replaceState(null, "", location.pathname);
});

function jsonLdScripts(): unknown[] {
	return [
		...document.head.querySelectorAll('script[type="application/ld+json"]'),
	].map((script) => JSON.parse(script.textContent ?? ""));
}

async function until(ready: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`never: ${what}`);
}

const HOSTILE = "</script><script>window.pwned = true</script>";

describe("photon > JSON-LD across navigations, in Chromium", () => {
	it("replaces the previous page's, and leaves none for a page without", async () => {
		const pageA: PhotonPageData = {
			component: "Product",
			framework: "react",
			url: "/a",
			props: {},
		};
		document.head.insertAdjacentHTML(
			"beforeend",
			serializeMetaTags({
				jsonLd: { "@type": "Product", "@id": "#a", name: "Anvil A" },
			}),
		);
		expect(jsonLdScripts()).toEqual([
			{
				"@context": "https://schema.org",
				"@type": "Product",
				"@id": "#a",
				name: "Anvil A",
			},
		]);

		const pages: Record<string, unknown> = {
			"/b": {
				component: "Product",
				framework: "react",
				url: "/b",
				props: {},
				meta: { jsonLd: [{ "@type": "Product", "@id": "#b", name: HOSTILE }] },
			},
			"/c": { component: "About", framework: "react", url: "/c", props: {} },
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (url: string) =>
					new Response(
						JSON.stringify(pages[new URL(url, location.href).pathname]),
						{
							headers: {
								"content-type": "application/json",
								"x-photon": "true",
							},
						},
					),
			),
		);
		const target = document.createElement("div");
		document.body.append(target);
		bootRouter({
			target,
			adapter: { update: () => {}, unmount: () => {} },
			resolveComponent: async () => ({ default: () => null }),
			page: pageA,
		});

		await router.visit("/b");
		await until(() => location.pathname === "/b", "navigated to /b");
		expect(jsonLdScripts()).toEqual([
			{
				"@context": "https://schema.org",
				"@type": "Product",
				"@id": "#b",
				name: HOSTILE,
			},
		]);
		expect(Reflect.get(window, "pwned")).toBeUndefined();

		await router.visit("/c");
		await until(() => location.pathname === "/c", "navigated to /c");
		expect(jsonLdScripts()).toEqual([]);
		target.remove();
	});
});
