// @vitest-environment jsdom

/**
 * `useInfiniteScroll`'s wiring, where jsdom can show it: which triggers are
 * observed, what a trigger firing asks the server for, how rows are tagged
 * with their page and remembered in history, and what `flush` stops. Layout —
 * what is in view, where the reader is — is covered in Chromium, in
 * `tests/browser/infinite-scroll.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhotonPageData } from "../../../src/client/hydrate.js";
// Aliased: the `use` prefix is Inertia's name for a composable, not a React
// hook, and the hooks lint rule would read it as one.
import {
	useInfiniteScroll as createInfiniteScroll,
	type UseInfiniteScrollOptions,
} from "../../../src/client/infiniteScroll.js";
import { bootRouter, router } from "../../../src/client/router.js";

/** An IntersectionObserver the test drives by hand. */
class FakeIntersectionObserver {
	static all: FakeIntersectionObserver[] = [];
	readonly targets = new Set<Element>();
	constructor(
		readonly callback: (
			entries: Array<Partial<IntersectionObserverEntry>>,
		) => void,
		readonly init: IntersectionObserverInit = {},
	) {
		FakeIntersectionObserver.all.push(this);
	}
	observe(target: Element): void {
		this.targets.add(target);
	}
	unobserve(target: Element): void {
		this.targets.delete(target);
	}
	disconnect(): void {
		this.targets.clear();
	}
	takeRecords(): [] {
		return [];
	}
	/** Every observer watching `target` sees it enter the viewport. */
	static intersect(target: Element): void {
		for (const observer of FakeIntersectionObserver.all) {
			if (observer.targets.has(target)) {
				observer.callback([{ isIntersecting: true, target }]);
			}
		}
	}
	static watching(target: Element): boolean {
		return FakeIntersectionObserver.all.some((o) => o.targets.has(target));
	}
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

function rows(page: number): number[] {
	return [page * 10 + 1, page * 10 + 2];
}

const nextFrames = () =>
	new Promise<void>((resolve) =>
		requestAnimationFrame(() =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		),
	);

let dom: { start: HTMLElement; items: HTMLElement; end: HTMLElement };

function render(props: Record<string, unknown>): void {
	const users = props.users;
	const data =
		typeof users === "object" && users !== null
			? Reflect.get(users, "data")
			: [];
	const existing = new Map(
		[...dom.items.children].map((child) => [child.textContent, child]),
	);
	dom.items.replaceChildren(
		...(Array.isArray(data) ? data : []).map((value) => {
			const text = `row ${String(value)}`;
			const node = existing.get(text) ?? document.createElement("div");
			node.textContent = text;
			return node;
		}),
	);
}

function boot(firstPage: number, last = 3): void {
	dom = {
		start: document.createElement("div"),
		items: document.createElement("div"),
		end: document.createElement("div"),
	};
	document.body.replaceChildren(dom.start, dom.items, dom.end);
	const page: PhotonPageData = {
		component: "Users",
		framework: "react",
		url: "/users",
		props: { users: { data: rows(firstPage) } },
		scrollProps: { users: cursor(firstPage, last) },
	};
	render(page.props);
	bootRouter({
		target: document.body,
		adapter: { update: (_c, props) => render(props), unmount() {} },
		resolveComponent: async () => ({ default: "Users" }),
		page,
	});
}

function options(
	overrides: Partial<UseInfiniteScrollOptions> = {},
): UseInfiniteScrollOptions {
	return {
		getPropName: () => "users",
		inReverseMode: () => false,
		shouldFetchNext: () => true,
		shouldFetchPrevious: () => true,
		shouldPreserveUrl: () => true,
		getTriggerMargin: () => 0,
		getStartElement: () => dom.start,
		getEndElement: () => dom.end,
		getItemsElement: () => dom.items,
		getScrollableParent: () => null,
		onBeforePreviousRequest: () => {},
		onBeforeNextRequest: () => {},
		onCompletePreviousRequest: () => {},
		onCompleteNextRequest: () => {},
		...overrides,
	};
}

function stubServer(last = 3) {
	const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
		const url = new URL(input, "http://localhost/");
		const page = Number(url.searchParams.get("page") ?? "1");
		const prepend =
			new Headers(init?.headers).get(
				"x-photon-infinite-scroll-merge-intent",
			) === "prepend";
		return new Response(
			JSON.stringify({
				component: "Users",
				framework: "react",
				url: url.pathname + url.search,
				props: { users: { data: rows(page) } },
				[prepend ? "prependProps" : "mergeProps"]: ["users.data"],
				scrollProps: { users: cursor(page, last) },
			}),
			{ headers: { "content-type": "application/json" } },
		);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function pageOf(index: number): string | undefined {
	const child = dom.items.children[index];
	return child instanceof HTMLElement
		? child.dataset.infiniteScrollPage
		: undefined;
}

beforeEach(() => {
	FakeIntersectionObserver.all = [];
	vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
	sessionStorage.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("photon/client > useInfiniteScroll wiring", () => {
	it("watches both triggers, and a trigger in view loads that side", async () => {
		const fetchMock = stubServer();
		boot(2);
		const completed: unknown[] = [];
		const scroll = createInfiniteScroll(
			options({
				onCompleteNextRequest: (details) => completed.push(["next", details]),
				onCompletePreviousRequest: (details) =>
					completed.push(["previous", details]),
			}),
		);
		scroll.elementManager.setupObservers();
		scroll.elementManager.processServerLoadedElements(2);
		scroll.elementManager.enableTriggers();
		expect(FakeIntersectionObserver.watching(dom.start)).toBe(true);
		expect(FakeIntersectionObserver.watching(dom.end)).toBe(true);

		FakeIntersectionObserver.intersect(dom.end);
		await vi.waitFor(() => expect(dom.items.children).toHaveLength(4));
		FakeIntersectionObserver.intersect(dom.start);
		await vi.waitFor(() => expect(dom.items.children).toHaveLength(6));

		expect([...dom.items.children].map((c) => c.textContent)).toEqual([
			"row 11",
			"row 12",
			"row 21",
			"row 22",
			"row 31",
			"row 32",
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(completed).toEqual([
			["next", { page: 3, completed: true }],
			["previous", { page: 1, completed: true }],
		]);
		await nextFrames();
		expect([0, 2, 4].map(pageOf)).toEqual(["1", "2", "3"]);
		scroll.flush();
	});

	it("does not watch a side the component says not to fetch", () => {
		stubServer();
		boot(2);
		const scroll = createInfiniteScroll(
			options({ shouldFetchPrevious: () => false }),
		);
		scroll.elementManager.setupObservers();
		scroll.elementManager.enableTriggers();
		expect(FakeIntersectionObserver.watching(dom.start)).toBe(false);
		expect(FakeIntersectionObserver.watching(dom.end)).toBe(true);
		scroll.elementManager.disableTriggers();
		expect(FakeIntersectionObserver.watching(dom.end)).toBe(false);
		scroll.flush();
	});

	it("marks rows the page added itself, so they are never counted as a page", async () => {
		stubServer();
		boot(1);
		const scroll = createInfiniteScroll(options());
		scroll.elementManager.setupObservers();
		scroll.elementManager.processServerLoadedElements(1);
		const own = document.createElement("div");
		own.textContent = "optimistic";
		dom.items.append(own);
		await new Promise((resolve) => setTimeout(resolve, 0));
		scroll.elementManager.processManuallyAddedElements();
		expect(own.dataset.infiniteScrollIgnore).toBe("true");
		expect(own.dataset.infiniteScrollPage).toBeUndefined();
		scroll.flush();
	});

	it("remembers which rows came with which page, and restores it on return", async () => {
		stubServer();
		boot(1);
		const first = createInfiniteScroll(options());
		first.elementManager.setupObservers();
		first.elementManager.processServerLoadedElements(1);
		await first.dataManager.fetchNext();
		await nextFrames();
		expect(router.restore("photon:infinite-scroll-elements:users")).toEqual({
			"1": { from: 0, to: 1 },
			"2": { from: 2, to: 3 },
		});
		expect(router.restore("photon:infinite-scroll-data:users")).toMatchObject({
			lastLoadedPage: 2,
			nextPage: 3,
			requestCount: 1,
		});
		first.flush();

		// Back on the list: the rows come back untagged, the ranges tag them.
		for (const child of dom.items.children) {
			if (child instanceof HTMLElement) {
				delete child.dataset.infiniteScrollPage;
			}
		}
		const again = createInfiniteScroll(options());
		again.elementManager.setupObservers();
		again.elementManager.processServerLoadedElements(1);
		expect([0, 1, 2, 3].map(pageOf)).toEqual(["1", "1", "2", "2"]);
		again.flush();
	});

	it("flush stops observing and listening", () => {
		stubServer();
		boot(2);
		const scroll = createInfiniteScroll(options());
		scroll.elementManager.setupObservers();
		scroll.elementManager.enableTriggers();
		scroll.flush();
		expect(FakeIntersectionObserver.watching(dom.end)).toBe(false);
		expect(FakeIntersectionObserver.watching(dom.start)).toBe(false);
	});
});
