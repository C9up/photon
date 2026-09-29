import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import type { PhotonPageData } from "../../src/client/hydrate.js";
import { router } from "../../src/client/router.js";
import { createPhotonApp } from "../../src/client/svelte/index.js";
import Counter from "./fixtures/Counter.svelte";
import UrlPage from "./fixtures/UrlPage.svelte";

/**
 * `createPhotonApp` from `@c9up/photon/svelte`, compiled by the Svelte Vite
 * plugin as an app compiles it: the SSR entry's `{ head, body }` rendered in
 * Node, then that markup hydrated in Chromium and driven by the router.
 */

async function renderSvelteApp(
	page: string,
	props: Record<string, unknown>,
	url: string,
): Promise<{ head: unknown; body: string }> {
	const command: unknown = Reflect.get(commands, "renderSvelteApp");
	if (typeof command !== "function") throw new Error("renderSvelteApp missing");
	const result: unknown = await Reflect.apply(command, commands, [
		page,
		props,
		url,
	]);
	const body: unknown = Reflect.get(Object(result), "body");
	if (typeof body !== "string") throw new Error("renderSvelteApp gave no body");
	return { head: Reflect.get(Object(result), "head"), body };
}

const fixtures: Record<string, unknown> = { Counter, UrlPage };

/** What PhotonRenderer writes around a server-rendered body. */
function serve(body: string, data: PhotonPageData): void {
	document.body.innerHTML = `<div id="app" data-server-rendered="true">${body}</div><script type="application/json" id="photon-data">${JSON.stringify(data)}</script>`;
}

async function until(ready: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`never: ${what}`);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	history.replaceState(null, "", location.pathname);
});

describe("photon/svelte > createPhotonApp", () => {
	it("renders { head, body } on the server, usePage reading the page", async () => {
		const { head, body } = await renderSvelteApp("UrlPage", {}, "/start");
		expect(head).toEqual([]);
		expect(body).toContain("<p>/start</p>");
	});

	it("hydrates the server's markup, then shows the pages the router visits", async () => {
		const { body } = await renderSvelteApp("Counter", { label: "a" }, "/start");
		serve(body, {
			component: "Counter",
			props: { label: "a" },
			url: "/start",
			framework: "svelte",
		});
		const serverButton = document.querySelector("button");
		const warn = vi.spyOn(console, "warn");

		await createPhotonApp({ resolve: (name) => fixtures[name] });
		const app = document.getElementById("app");
		// Taken over, not mounted beside it.
		expect(app?.querySelectorAll("button")).toHaveLength(1);
		expect(document.querySelector("button")).toBe(serverButton);
		expect(warn.mock.calls.flat().join(" ")).not.toMatch(/hydrat|mismatch/i);

		document.querySelector("button")?.click();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							component: "Counter",
							props: { label: "b" },
							url: "/next",
							framework: "svelte",
						}),
						{ headers: { "content-type": "application/json" } },
					),
			),
		);
		await router.visit("/next");
		// The same page with new props keeps its state: one click, kept.
		await until(() => app?.textContent?.trim() === "b:1", '"b:1"');
	});
});
