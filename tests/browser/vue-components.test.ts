import { afterEach, describe, expect, it, vi } from "vitest";
import { type Component, createApp, h, shallowRef } from "vue";
import type { PhotonPageData } from "../../src/client/hydrate.js";
import { bootRouter } from "../../src/client/router.js";
import { InfiniteScroll, WhenVisible } from "../../src/client/vue/index.js";

/**
 * `WhenVisible` and `InfiniteScroll` from `@c9up/photon/vue` in Chromium, with
 * the real Vue: they load when something scrolls into view.
 */

let unmount: (() => void) | undefined;

afterEach(() => {
	unmount?.();
	unmount = undefined;
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	history.replaceState(null, "", location.pathname);
});

function jsonPage(page: Record<string, unknown>): Response {
	return new Response(
		JSON.stringify({ component: "Page", framework: "vue", ...page }),
		{ headers: { "content-type": "application/json" } },
	);
}

function mountPage(Page: Component, page: PhotonPageData): HTMLElement {
	const target = document.createElement("div");
	document.body.append(target);
	const props = shallowRef(page.props);
	const app = createApp({ render: () => h(Page, props.value) });
	bootRouter({
		target,
		adapter: {
			update: (_component, next) => {
				props.value = next;
			},
			unmount: () => app.unmount(),
		},
		resolveComponent: async () => ({ default: Page }),
		page,
	});
	app.mount(target);
	unmount = () => app.unmount();
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

describe("photon/vue > WhenVisible in Chromium", () => {
	it("loads its props once it scrolls into view, not before", async () => {
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
			jsonPage({ url: location.pathname, props: { comments: ["first!"] } }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const Page = {
			props: ["comments"],
			setup(props: { comments?: string[] }) {
				return () =>
					h("div", [
						h("div", { style: { height: "2000px" } }),
						h(
							WhenVisible,
							{ data: "comments" },
							{
								fallback: () => h("p", "waiting"),
								default: () =>
									h("p", `comments: ${JSON.stringify(props.comments)}`),
							},
						),
					]);
			},
		};
		const target = mountPage(Page, {
			component: "Page",
			framework: "vue",
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
		expect(
			new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
				"x-photon-partial-data",
			),
		).toBe("comments");
		window.scrollTo(0, 0);
	});
});

describe("photon/vue > InfiniteScroll in Chromium", () => {
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
		const Page = {
			props: ["users"],
			setup(props: { users?: { data: number[] } }) {
				return () =>
					h(
						"div",
						{ id: "scroller", style: { height: "150px", overflowY: "auto" } },
						h(
							InfiniteScroll,
							{ data: "users" },
							{
								loading: () => h("p", { id: "loading" }, "loading…"),
								default: () =>
									(props.users?.data ?? []).map((row) =>
										h(
											"div",
											{ key: row, style: { height: "100px" } },
											`row ${row}`,
										),
									),
							},
						),
					);
			},
		};
		const target = mountPage(Page, {
			component: "Page",
			framework: "vue",
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
			"the loading slot",
		);
		await until(
			() => target.textContent?.includes("row 22") ?? false,
			"page 2",
		);
		expect(target.textContent).toContain("row 11");
		expect(target.querySelector("#loading")).toBeNull();
	});
});
