import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhotonPageData } from "../../src/client/hydrate.js";
// Aliased: the `use` prefix is Inertia's name for a composable, not a React
// hook, and the hooks lint rule would read it as one.
import {
	useInfiniteScroll as createInfiniteScroll,
	type UseInfiniteScrollProps,
} from "../../src/client/infiniteScroll.js";
import { bootRouter } from "../../src/client/router.js";

/**
 * `useInfiniteScroll` in Chromium, where there is layout: real
 * IntersectionObservers on the triggers, a real scrollable container, real
 * scroll offsets. jsdom has none of these, so none of this can be shown there.
 *
 * The "framework" is a renderer that keeps each row's node from one render to
 * the next, as a keyed list does — the element manager tags rows by page, and
 * a renderer that rebuilt every node would lose the tags.
 */

const ROW_HEIGHT = 50;
const PER_PAGE = 10;

function rows(page: number): number[] {
	return Array.from(
		{ length: PER_PAGE },
		(_, i) => (page - 1) * PER_PAGE + i + 1,
	);
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

interface Fixture {
	container: HTMLElement;
	items: HTMLElement;
	start: HTMLElement;
	end: HTMLElement;
	scroll: UseInfiniteScrollProps;
	completed: number[];
}

let fixture: Fixture | undefined;

beforeEach(() => {
	document.body.replaceChildren();
});

afterEach(() => {
	fixture?.scroll.flush();
	fixture = undefined;
	vi.unstubAllGlobals();
	history.replaceState(null, "", location.pathname);
});

/** The server: every page of a 5-page list, labelled the way photon's server labels it. */
function stubServer(last = 5) {
	const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
		const url = new URL(input, location.href);
		const page = Number(url.searchParams.get("page") ?? "1");
		const headers = new Headers(init?.headers);
		const prepend =
			headers.get("x-photon-infinite-scroll-merge-intent") === "prepend";
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

async function mount(firstPage: number, last = 5): Promise<Fixture> {
	const container = document.createElement("div");
	container.style.cssText = "height: 300px; overflow-y: auto;";
	const start = document.createElement("div");
	start.style.height = "1px";
	const items = document.createElement("div");
	const end = document.createElement("div");
	end.style.height = "1px";
	container.append(start, items, end);
	document.body.append(container);

	const nodes = new Map<number, HTMLElement>();
	const render = (props: Record<string, unknown>): void => {
		const users = props.users;
		const data =
			typeof users === "object" && users !== null
				? Reflect.get(users, "data")
				: [];
		const list: HTMLElement[] = [];
		for (const value of Array.isArray(data) ? data : []) {
			if (typeof value !== "number") continue;
			let node = nodes.get(value);
			if (node === undefined) {
				node = document.createElement("div");
				node.textContent = `row ${value}`;
				node.style.height = `${ROW_HEIGHT}px`;
				nodes.set(value, node);
			}
			list.push(node);
		}
		items.replaceChildren(...list);
	};

	const page: PhotonPageData = {
		component: "Users",
		framework: "react",
		url: location.pathname,
		props: { users: { data: rows(firstPage) } },
		scrollProps: { users: cursor(firstPage, last) },
	};
	render(page.props);
	bootRouter({
		target: container,
		adapter: { update: (_component, props) => render(props), unmount() {} },
		resolveComponent: async () => ({ default: "Users" }),
		page,
	});

	const completed: number[] = [];
	const scroll = createInfiniteScroll({
		getPropName: () => "users",
		inReverseMode: () => false,
		shouldFetchNext: () => true,
		shouldFetchPrevious: () => true,
		shouldPreserveUrl: () => false,
		getTriggerMargin: () => 0,
		getStartElement: () => start,
		getEndElement: () => end,
		getItemsElement: () => items,
		getScrollableParent: () => container,
		onBeforePreviousRequest: () => {},
		onBeforeNextRequest: () => {},
		onCompletePreviousRequest: ({ page }) => {
			if (typeof page === "number") completed.push(page);
		},
		onCompleteNextRequest: ({ page }) => {
			if (typeof page === "number") completed.push(page);
		},
	});
	scroll.elementManager.setupObservers();
	scroll.elementManager.processServerLoadedElements(firstPage);
	fixture = { container, items, start, end, scroll, completed };
	return fixture;
}

async function until(ready: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`never: ${what}`);
}

describe("photon/client > useInfiniteScroll in Chromium", () => {
	it("loads the next page when the end trigger scrolls into view", async () => {
		const fetchMock = stubServer();
		const { container, items, scroll } = await mount(1);
		scroll.elementManager.enableTriggers();
		// The first rows fill the container: the end trigger is out of view.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(fetchMock).not.toHaveBeenCalled();

		container.scrollTop = container.scrollHeight;
		await until(() => items.children.length === 20, "page 2 rendered");

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(new URL(String(url), location.href).searchParams.get("page")).toBe(
			"2",
		);
		expect(
			new Headers(init?.headers).get("x-photon-infinite-scroll-merge-intent"),
		).toBe("append");
		// Rows are tagged with the page they came with.
		await until(
			() =>
				items.children[PER_PAGE] instanceof HTMLElement &&
				items.children[PER_PAGE].dataset.infiniteScrollPage === "2",
			"page 2 tagged",
		);
		expect(
			items.children[0] instanceof HTMLElement &&
				items.children[0].dataset.infiniteScrollPage,
		).toBe("1");
	});

	it("stops asking once the last page is in", async () => {
		const fetchMock = stubServer(2);
		const { container, items, scroll } = await mount(1, 2);
		scroll.elementManager.enableTriggers();
		container.scrollTop = container.scrollHeight;
		await until(() => items.children.length === 20, "page 2 rendered");
		expect(scroll.dataManager.hasNext()).toBe(false);

		container.scrollTop = container.scrollHeight;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("moves the URL to the page most visible on screen", async () => {
		stubServer();
		const { container, items, scroll } = await mount(1);
		scroll.elementManager.enableTriggers();
		container.scrollTop = container.scrollHeight;
		await until(() => items.children.length === 20, "page 2 rendered");
		await until(
			() =>
				items.children[PER_PAGE] instanceof HTMLElement &&
				items.children[PER_PAGE].dataset.infiniteScrollPage === "2",
			"page 2 tagged",
		);

		// Well inside page 2's rows.
		container.scrollTop = PER_PAGE * ROW_HEIGHT + 100;
		await until(
			() => new URL(location.href).searchParams.get("page") === "2",
			"the URL on page 2",
		);

		container.scrollTop = 0;
		await until(
			() => !new URL(location.href).searchParams.has("page"),
			"the URL back on page 1",
		);
	});

	it("keeps the reader's row in place when the previous page arrives above it", async () => {
		stubServer();
		const { container, items, scroll } = await mount(3);
		// The reader is looking at row 25, a little way into page 3.
		container.scrollTop = 4 * ROW_HEIGHT;
		const reader = [...items.children].find(
			(child) => child.textContent === "row 25",
		);
		if (!(reader instanceof HTMLElement)) throw new Error("row 25 missing");
		const before =
			reader.getBoundingClientRect().top -
			container.getBoundingClientRect().top;

		await scroll.dataManager.fetchPrevious();
		await until(() => items.children.length === 20, "page 2 rendered above");
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(items.children[0]?.textContent).toBe("row 11");
		const after =
			reader.getBoundingClientRect().top -
			container.getBoundingClientRect().top;
		expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
	});
});
