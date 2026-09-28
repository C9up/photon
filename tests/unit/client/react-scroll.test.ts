// @vitest-environment jsdom

/**
 * `WhenVisible` and `InfiniteScroll` from `@c9up/photon/react`, wired to the
 * router with an IntersectionObserver the test drives: what loads when, what
 * the slots are given, manual mode and the methods a ref exposes. The same
 * components scroll for real in `tests/browser/react-components.test.ts`.
 */

import { act, createElement, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { PhotonPageData } from "../../../src/client/hydrate.js";
import {
	InfiniteScroll,
	type InfiniteScrollActionSlotProps,
	type InfiniteScrollRef,
	WhenVisible,
	type WhenVisibleProps,
} from "../../../src/client/react/index.js";
import { bootRouter } from "../../../src/client/router.js";
import { FakeIntersectionObserver } from "./support/fake-intersection-observer.js";

beforeAll(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

let root: Root | undefined;

beforeEach(() => {
	FakeIntersectionObserver.all = [];
	vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
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

/**
 * Wait for `ready`, one tick at a time inside `act`, so React flushes what
 * each tick scheduled — a `waitFor` inside a single `act` never sees updates
 * that `act` only flushes when it ends.
 */
async function until(ready: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (ready()) return;
		await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
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

function stubPages(last = 3) {
	const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
		const page = Number(
			new URL(input, "http://localhost/").searchParams.get("page") ?? "1",
		);
		return jsonPage({
			url: "/users",
			props: { users: { data: [page * 10 + 1] } },
			mergeProps: ["users.data"],
			scrollProps: { users: cursor(page, last) },
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function rowsOf(props: Record<string, unknown>): number[] {
	const users = props.users;
	const data =
		typeof users === "object" && users !== null
			? Reflect.get(users, "data")
			: [];
	return Array.isArray(data)
		? data.filter((v): v is number => typeof v === "number")
		: [];
}

describe("photon/react > WhenVisible wiring", () => {
	it("reloads its props when its element comes into view, then stops watching", async () => {
		const fetchMock = vi.fn(async () =>
			jsonPage({ url: "/", props: { comments: ["hi"] } }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const Page = (props: Record<string, unknown>): ReactNode =>
			createElement(
				WhenVisible,
				{
					data: "comments",
					fallback: () => createElement("p", null, "waiting"),
				},
				createElement("p", null, `comments ${JSON.stringify(props.comments)}`),
			);
		const target = await mountPage(Page, {
			component: "Page",
			framework: "react",
			url: "/",
			props: {},
		});
		expect(target.textContent).toBe("waiting");
		const sentinel = target.querySelector("div");
		if (!sentinel) throw new Error("no sentinel");

		await act(async () => {
			FakeIntersectionObserver.intersect(sentinel);
		});
		await until(
			() => target.textContent === 'comments ["hi"]',
			"'comments [\"hi\"]'",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(FakeIntersectionObserver.watching(sentinel)).toBe(false);
	});

	it("keeps watching with always, and hands children the fetching flag", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonPage({ url: "/", props: { n: 2 } })),
		);
		const Page = (props: Record<string, unknown>): ReactNode => {
			// A render-prop child is a prop; `createElement`'s children take nodes.
			const visible: WhenVisibleProps = {
				data: "n",
				always: true,
				as: "section",
				children: ({ fetching }) =>
					createElement(
						"p",
						null,
						`n ${String(props.n)}${fetching ? "…" : ""}`,
					),
			};
			return createElement(WhenVisible, visible);
		};
		const target = await mountPage(Page, {
			component: "Page",
			framework: "react",
			url: "/",
			props: { n: 1 },
		});
		const sentinel = target.querySelector("section");
		if (!sentinel) throw new Error("no section");
		expect(target.textContent).toBe("n 1");
		await act(async () => {
			FakeIntersectionObserver.intersect(sentinel);
		});
		await until(() => target.textContent === "n 2", '"n 2"');
		expect(FakeIntersectionObserver.watching(sentinel)).toBe(true);
	});
});

describe("photon/react > InfiniteScroll wiring", () => {
	function listPage(
		extra: Record<string, unknown> = {},
		ref?: ReturnType<typeof createRef<InfiniteScrollRef>>,
	) {
		return (props: Record<string, unknown>): ReactNode =>
			createElement(
				InfiniteScroll,
				{
					data: "users",
					ref,
					next: (slot: InfiniteScrollActionSlotProps) =>
						createElement(
							"button",
							{ type: "button", onClick: slot.fetch },
							`${slot.manualMode ? "manual" : "auto"} ${slot.hasMore ? "more" : "end"}`,
						),
					...extra,
				},
				rowsOf(props).map((row) =>
					createElement("div", { key: row }, `row ${row}`),
				),
			);
	}

	it("loads the next page when the end trigger comes into view", async () => {
		const fetchMock = stubPages();
		const target = await mountPage(listPage(), {
			component: "Page",
			framework: "react",
			url: "/users",
			props: { users: { data: [11] } },
			scrollProps: { users: cursor(1, 3) },
		});
		const end = target.querySelector("button")?.parentElement;
		if (!end) throw new Error("no end trigger");
		expect(target.textContent).toContain("auto more");

		await act(async () => {
			FakeIntersectionObserver.intersect(end);
		});
		await until(
			() => target.textContent?.includes("row 21") ?? false,
			'"row 21"',
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("switches to manual after manualAfter loads, and the slot's fetch still loads", async () => {
		stubPages();
		const target = await mountPage(listPage({ manualAfter: 1 }), {
			component: "Page",
			framework: "react",
			url: "/users",
			props: { users: { data: [11] } },
			scrollProps: { users: cursor(1, 3) },
		});
		const end = target.querySelector("button")?.parentElement;
		if (!end) throw new Error("no end trigger");
		await act(async () => {
			FakeIntersectionObserver.intersect(end);
		});
		await until(
			() => target.textContent?.includes("manual more") ?? false,
			'"manual more"',
		);
		expect(FakeIntersectionObserver.watching(end)).toBe(false);

		await act(async () => {
			target.querySelector("button")?.click();
		});
		await until(
			() => target.textContent?.includes("row 31") ?? false,
			'"row 31"',
		);
		expect(target.textContent).toContain("manual end");
	});

	it("exposes fetchNext, hasNext and hasPrevious through its ref", async () => {
		stubPages(2);
		const ref = createRef<InfiniteScrollRef>();
		const target = await mountPage(listPage({ manual: true }, ref), {
			component: "Page",
			framework: "react",
			url: "/users",
			props: { users: { data: [11] } },
			scrollProps: { users: cursor(1, 2) },
		});
		expect(ref.current?.hasNext()).toBe(true);
		expect(ref.current?.hasPrevious()).toBe(false);
		await act(async () => {
			ref.current?.fetchNext();
		});
		await until(
			() => target.textContent?.includes("row 21") ?? false,
			'"row 21"',
		);
		expect(ref.current?.hasNext()).toBe(false);
	});
});
