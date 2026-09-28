import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PhotonPageData } from "../../src/client/hydrate.js";
import { InfiniteScroll, WhenVisible } from "../../src/client/react/index.js";
import { bootRouter } from "../../src/client/router.js";

/**
 * `WhenVisible` and `InfiniteScroll` from `@c9up/photon/react` in Chromium,
 * with the real React: they load when something scrolls into view, which
 * needs a viewport.
 */

beforeAll(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

let root: Root | undefined;

afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	history.replaceState(null, "", location.pathname);
});

function jsonPage(page: Record<string, unknown>): Response {
	return new Response(
		JSON.stringify({ component: "Page", framework: "react", ...page }),
		{ headers: { "content-type": "application/json" } },
	);
}

async function mountPage(
	Page: (props: Record<string, unknown>) => ReactNode,
	page: PhotonPageData,
): Promise<HTMLElement> {
	const target = document.createElement("div");
	document.body.append(target);
	const reactRoot = createRoot(target);
	root = reactRoot;
	await act(async () => {
		bootRouter({
			target,
			adapter: {
				update: (_component, props) =>
					reactRoot.render(createElement(Page, props)),
				unmount: () => reactRoot.unmount(),
			},
			resolveComponent: async () => ({ default: Page }),
			page,
		});
		reactRoot.render(createElement(Page, page.props));
	});
	return target;
}

async function until(ready: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (ready()) return;
		await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
	}
	throw new Error(`never: ${what}`);
}

describe("photon/react > WhenVisible in Chromium", () => {
	it("loads its props once it scrolls into view, not before", async () => {
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
			jsonPage({ url: location.pathname, props: { comments: ["first!"] } }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const Page = (props: Record<string, unknown>): ReactNode =>
			createElement(
				"div",
				null,
				createElement("div", { style: { height: "2000px" } }),
				createElement(
					WhenVisible,
					{
						data: "comments",
						fallback: createElement("p", null, "waiting"),
					},
					createElement(
						"p",
						null,
						`comments: ${JSON.stringify(props.comments)}`,
					),
				),
			);
		const target = await mountPage(Page, {
			component: "Page",
			framework: "react",
			url: location.pathname,
			props: {},
		});
		await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
		expect(fetchMock).not.toHaveBeenCalled();
		expect(target.textContent).toContain("waiting");

		window.scrollTo(0, document.body.scrollHeight);
		await until(
			() => target.textContent?.includes('comments: ["first!"]') ?? false,
			"the comments",
		);
		const init: RequestInit | undefined = fetchMock.mock.calls[0]?.[1];
		expect(new Headers(init?.headers).get("x-photon-partial-data")).toBe(
			"comments",
		);
		window.scrollTo(0, 0);
	});
});

function cursor(page: number, last: number) {
	return {
		pageName: "page",
		currentPage: page,
		nextPage: page < last ? page + 1 : null,
		previousPage: page > 1 ? page - 1 : null,
		reset: false,
	};
}

describe("photon/react > InfiniteScroll in Chromium", () => {
	it("renders the next page as the reader reaches the end, and says when it is loading", async () => {
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
		const Page = (props: Record<string, unknown>): ReactNode => {
			const users = props.users;
			const rows =
				typeof users === "object" && users !== null
					? Reflect.get(users, "data")
					: [];
			return createElement(
				"div",
				{ style: { height: "150px", overflowY: "auto" }, id: "scroller" },
				createElement(
					InfiniteScroll,
					{
						data: "users",
						loading: createElement("p", { id: "loading" }, "loading…"),
					},
					(Array.isArray(rows) ? rows : []).map((row) =>
						createElement(
							"div",
							{ key: String(row), style: { height: "100px" } },
							`row ${String(row)}`,
						),
					),
				),
			);
		};
		const target = await mountPage(Page, {
			component: "Page",
			framework: "react",
			url: location.pathname,
			props: { users: { data: [11, 12] } },
			scrollProps: { users: cursor(1, 2) },
		});
		const scroller = target.querySelector("#scroller");
		if (!(scroller instanceof HTMLElement)) throw new Error("no scroller");
		expect(target.textContent).not.toContain("row 21");

		scroller.scrollTop = scroller.scrollHeight;
		await until(
			() => target.querySelector("#loading") !== null,
			"the loading slot",
		);
		await until(
			() => target.textContent?.includes("row 22") ?? false,
			"page 2 rendered",
		);
		expect(target.textContent).toContain("row 11");
		expect(target.querySelector("#loading")).toBeNull();
	});
});
