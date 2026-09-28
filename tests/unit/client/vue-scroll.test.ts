// @vitest-environment jsdom

/**
 * `WhenVisible` and `InfiniteScroll` from `@c9up/photon/vue`, wired to the
 * router with an IntersectionObserver the test drives: what loads when, the
 * slots, manual mode and the exposed methods. They scroll for real in
 * `tests/browser/vue-components.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Component, createApp, h, ref, shallowRef } from "vue";
import type { PhotonPageData } from "../../../src/client/hydrate.js";
import { bootRouter } from "../../../src/client/router.js";
import { InfiniteScroll, WhenVisible } from "../../../src/client/vue/index.js";
import { FakeIntersectionObserver } from "./support/fake-intersection-observer.js";

let unmount: (() => void) | undefined;

beforeEach(() => {
	FakeIntersectionObserver.all = [];
	vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
	unmount?.();
	unmount = undefined;
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
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
	for (let i = 0; i < 100; i++) {
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

function stubPages(last = 3) {
	const fetchMock = vi.fn(async (input: string) => {
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

describe("photon/vue > WhenVisible wiring", () => {
	it("reloads its props when its element comes into view, then stops watching", async () => {
		const fetchMock = vi.fn(async () =>
			jsonPage({ url: "/", props: { comments: ["hi"] } }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const Page = {
			props: ["comments"],
			setup(props: { comments?: string[] }) {
				return () =>
					h(
						WhenVisible,
						{ data: "comments" },
						{
							fallback: () => h("p", "waiting"),
							default: () =>
								h("p", `comments ${JSON.stringify(props.comments)}`),
						},
					);
			},
		};
		const target = mountPage(Page, {
			component: "Page",
			framework: "vue",
			url: "/",
			props: {},
		});
		await until(() => target.querySelector("div") !== null, "the sentinel");
		const sentinel = target.querySelector("div");
		if (!sentinel) throw new Error("no sentinel");
		await until(
			() => FakeIntersectionObserver.watching(sentinel),
			"the observer",
		);
		FakeIntersectionObserver.intersect(sentinel);
		await until(() => target.textContent === 'comments ["hi"]', "the comments");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("photon/vue > InfiniteScroll wiring", () => {
	function listPage(
		extra: Record<string, unknown> = {},
		exposed?: ReturnType<typeof ref>,
	) {
		return {
			props: ["users"],
			setup(props: { users?: { data: number[] } }) {
				return () =>
					h(
						InfiniteScroll,
						{ data: "users", ref: exposed, ...extra },
						{
							next: (slot: {
								fetch: () => void;
								manualMode: boolean;
								hasMore: boolean;
							}) =>
								h(
									"button",
									{ type: "button", onClick: slot.fetch },
									`${slot.manualMode ? "manual" : "auto"} ${slot.hasMore ? "more" : "end"}`,
								),
							default: () =>
								(props.users?.data ?? []).map((row) =>
									h("div", { key: row }, `row ${row}`),
								),
						},
					);
			},
		};
	}

	const firstPage = (last = 3): PhotonPageData => ({
		component: "Page",
		framework: "vue",
		url: "/users",
		props: { users: { data: [11] } },
		scrollProps: { users: cursor(1, last) },
	});

	it("loads the next page when the end trigger comes into view", async () => {
		const fetchMock = stubPages();
		const target = mountPage(listPage(), firstPage());
		await until(() => target.querySelector("button") !== null, "the next slot");
		const end = target.querySelector("button")?.parentElement;
		if (!end) throw new Error("no end trigger");
		expect(target.textContent).toContain("auto more");
		await until(() => FakeIntersectionObserver.watching(end), "the trigger");
		FakeIntersectionObserver.intersect(end);
		await until(
			() => target.textContent?.includes("row 21") ?? false,
			"page 2",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("switches to manual after manualAfter loads, and the slot's fetch still loads", async () => {
		stubPages();
		const target = mountPage(listPage({ manualAfter: 1 }), firstPage());
		await until(() => target.querySelector("button") !== null, "the next slot");
		const end = target.querySelector("button")?.parentElement;
		if (!end) throw new Error("no end trigger");
		await until(() => FakeIntersectionObserver.watching(end), "the trigger");
		FakeIntersectionObserver.intersect(end);
		await until(
			() => target.textContent?.includes("manual more") ?? false,
			"manual mode",
		);
		expect(FakeIntersectionObserver.watching(end)).toBe(false);
		target.querySelector("button")?.click();
		await until(
			() => target.textContent?.includes("row 31") ?? false,
			"page 3",
		);
		expect(target.textContent).toContain("manual end");
	});

	it("exposes fetchNext, hasNext and hasPrevious", async () => {
		stubPages(2);
		const exposed = ref();
		const target = mountPage(listPage({ manual: true }, exposed), firstPage(2));
		await until(() => exposed.value !== undefined, "the instance");
		const api: unknown = exposed.value;
		const call = (name: string): unknown => {
			const fn: unknown =
				typeof api === "object" && api !== null
					? Reflect.get(api, name)
					: undefined;
			return typeof fn === "function" ? fn() : undefined;
		};
		expect(call("hasNext")).toBe(true);
		expect(call("hasPrevious")).toBe(false);
		call("fetchNext");
		await until(
			() => target.textContent?.includes("row 21") ?? false,
			"page 2",
		);
		expect(call("hasNext")).toBe(false);
	});
});
