import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import type { PhotonPageData } from "../../src/client/hydrate.js";
import { bootRouter, router } from "../../src/client/router.js";
import PhotonRoot from "../../src/client/svelte/PhotonRoot.svelte";
import DeferredPage from "./fixtures/DeferredPage.svelte";
import FormPage from "./fixtures/FormPage.svelte";
import LinkPage from "./fixtures/LinkPage.svelte";
import ScrollPage from "./fixtures/ScrollPage.svelte";
import VisiblePage from "./fixtures/VisiblePage.svelte";

/**
 * `@c9up/photon/svelte`'s components in Chromium, compiled by the Svelte Vite
 * plugin as an app compiles them: `usePage` on the server through
 * `PhotonRoot`, and `Deferred`, `WhenVisible`, `InfiniteScroll` following
 * the router in the browser.
 */

async function renderSvelte(
	page: string,
	props: Record<string, unknown>,
	url?: string,
): Promise<string> {
	const command: unknown = Reflect.get(commands, "renderSvelte");
	if (typeof command !== "function") throw new Error("renderSvelte missing");
	const html: unknown = await Reflect.apply(command, commands, [
		page,
		props,
		url,
	]);
	if (typeof html !== "string")
		throw new Error("renderSvelte returned no HTML");
	return html;
}

let instance: Record<string, unknown> | undefined;

afterEach(() => {
	if (instance) unmount(instance);
	instance = undefined;
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	history.replaceState(null, "", location.pathname);
});

function jsonPage(page: Record<string, unknown>): Response {
	return new Response(
		JSON.stringify({ component: "Page", framework: "svelte", ...page }),
		{ headers: { "content-type": "application/json" } },
	);
}

/** Mount `Page` through `PhotonRoot`, updated by the router as the adapter does. */
function mountPage(Page: unknown, page: PhotonPageData): HTMLElement {
	const target = document.createElement("div");
	document.body.append(target);
	bootRouter({
		target,
		adapter: {
			update: (component, props) => {
				const setPage: unknown = Reflect.get(root, "setPage");
				if (typeof setPage === "function") {
					Reflect.apply(setPage, root, [{ component, props }]);
				}
			},
			unmount() {},
		},
		resolveComponent: async () => ({ default: Page }),
		page,
	});
	const root = mount(PhotonRoot, {
		target,
		props: { component: Page, props: page.props },
	});
	instance = root;
	return target;
}

async function until(ready: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`never: ${what}`);
}

function cursor(page: number, last: number) {
	return {
		pageName: "page",
		currentPage: page,
		nextPage: page < last ? page + 1 : null,
		previousPage: page > 1 ? page - 1 : null,
		reset: false,
	};
}

describe("photon/svelte > usePage on the server", () => {
	it("reads the page PhotonRoot is given", async () => {
		const html = await renderSvelte("UrlPage", {}, "/from-the-server");
		expect(html).toContain("/from-the-server");
	});
});

describe("photon/svelte > Deferred in Chromium", () => {
	it("shows the fallback until the group arrives, then says when it reloads", async () => {
		let release: (() => void) | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const partial = new Headers(init?.headers).get("cache-control");
				if (partial === "no-cache") {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return jsonPage({ url: location.pathname, props: { stats: 43 } });
				}
				return jsonPage({ url: location.pathname, props: { stats: 42 } });
			}),
		);
		const target = mountPage(DeferredPage, {
			component: "Page",
			framework: "svelte",
			url: location.pathname,
			props: {},
			deferredProps: { default: ["stats"] },
		});
		expect(target.textContent?.trim()).toBe("loading");
		await until(() => target.textContent?.trim() === "stats 42", "the group");

		const reload = router.reload({ only: ["stats"] });
		await until(
			() => target.textContent?.trim() === "stats 42 (reloading)",
			"the reloading flag",
		);
		release?.();
		await reload;
		await until(() => target.textContent?.trim() === "stats 43", "the reload");
	});
});

describe("photon/svelte > WhenVisible in Chromium", () => {
	it("loads its props once it scrolls into view, not before", async () => {
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
			jsonPage({ url: location.pathname, props: { comments: ["first!"] } }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const target = mountPage(VisiblePage, {
			component: "Page",
			framework: "svelte",
			url: location.pathname,
			props: {},
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(fetchMock).not.toHaveBeenCalled();
		expect(target.textContent).toContain("waiting");

		window.scrollTo(0, document.body.scrollHeight);
		await until(
			() => target.textContent?.includes('comments: ["first!"]') ?? false,
			"the comments",
		);
		window.scrollTo(0, 0);
	});
});

describe("photon/svelte > InfiniteScroll in Chromium", () => {
	it("renders the next page as the reader reaches the end", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				const page = Number(
					new URL(input, location.href).searchParams.get("page") ?? "1",
				);
				await new Promise((resolve) => setTimeout(resolve, 50));
				return jsonPage({
					url: location.pathname,
					props: { users: { data: [page * 10 + 1, page * 10 + 2] } },
					mergeProps: ["users.data"],
					scrollProps: { users: cursor(page, 2) },
				});
			}),
		);
		const target = mountPage(ScrollPage, {
			component: "Page",
			framework: "svelte",
			url: location.pathname,
			props: { users: { data: [11, 12] } },
			scrollProps: { users: cursor(1, 2) },
		});
		const scroller = target.querySelector("#scroller");
		if (!(scroller instanceof HTMLElement)) throw new Error("no scroller");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(target.textContent).not.toContain("row 21");

		scroller.scrollTop = scroller.scrollHeight;
		await until(
			() => target.querySelector("#loading") !== null,
			"the loading snippet",
		);
		await until(
			() => target.textContent?.includes("row 22") ?? false,
			"page 2",
		);
		expect(target.textContent).toContain("row 11");
	});
});

describe("photon/svelte > Link in Chromium", () => {
	it("is an anchor for GET, a button that sends its body for a mutation", async () => {
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
			jsonPage({ url, props: {} }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const target = mountPage(LinkPage, {
			component: "Page",
			framework: "svelte",
			url: location.pathname,
			props: {},
		});
		const anchor = target.querySelector("a");
		expect(anchor?.getAttribute("href")).toBe("/search?q=tea");
		const button = target.querySelector("button");
		expect(button?.getAttribute("type")).toBe("button");

		button?.click();
		await until(() => fetchMock.mock.calls.length === 1, "the DELETE");
		const init: RequestInit | undefined = fetchMock.mock.calls[0]?.[1];
		expect(init?.method).toBe("DELETE");
		expect(init?.body).toBe('{"reason":"dup"}');
	});
});

describe("photon/svelte > useForm and Form in Chromium", () => {
	it("binds fields, shows the page's errors, and submits what was typed", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
			jsonPage({
				url: location.pathname,
				props:
					typeof init?.body === "string" && init.body.includes('"email":""')
						? { errors: { email: "required" } }
						: {},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const target = mountPage(FormPage, {
			component: "Page",
			framework: "svelte",
			url: location.pathname,
			props: {},
		});
		const hook = target.querySelector("#use-form");
		const input = hook?.querySelector("input");
		const text = () => hook?.querySelector("p")?.textContent ?? "";
		if (!(input instanceof HTMLInputElement)) throw new Error("no input");

		hook?.querySelector("button")?.click();
		await until(() => text().startsWith("required"), "the error");
		input.value = "a@b.c";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await until(() => text().endsWith("dirty"), "dirty");
		hook?.querySelector("button")?.click();
		await until(() => text() === "|clean", "a clean success");
		expect(fetchMock.mock.calls[1]?.[1]?.body).toBe('{"email":"a@b.c"}');

		const form = target.querySelector("#form");
		form?.querySelector("button")?.click();
		await until(
			() => form?.querySelector("p")?.textContent === "required",
			"the <Form> error",
		);
	});
});
