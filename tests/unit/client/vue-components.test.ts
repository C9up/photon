// @vitest-environment jsdom

/**
 * `@c9up/photon/vue` against the real Vue: `usePage` following the router,
 * the `PhotonPage` provider the SSR entry uses, and `Deferred` following the
 * deferred props the router loads. `WhenVisible` and `InfiniteScroll` need a
 * viewport and are in `tests/browser`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createApp,
	createSSRApp,
	defineComponent,
	h,
	nextTick,
	shallowRef,
} from "vue";
import { renderToString } from "vue/server-renderer";
import type { PhotonPageData } from "../../../src/client/hydrate.js";
import { bootRouter, router } from "../../../src/client/router.js";
// Aliased: `use` is Inertia's prefix for a composable, and the React hooks
// lint rule would read it as a hook called outside a component.
import {
	Deferred,
	PhotonPage,
	usePage as readPage,
} from "../../../src/client/vue/index.js";

function jsonPage(page: Record<string, unknown>): Response {
	return new Response(JSON.stringify({ framework: "vue", ...page }), {
		headers: { "content-type": "application/json" },
	});
}

let unmount: (() => void) | undefined;

afterEach(() => {
	unmount?.();
	unmount = undefined;
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** Mount `Page` as the router's page, the way the Vue adapter renders it. */
function mountPage(
	Page: ReturnType<typeof defineComponent>,
	page: PhotonPageData,
): HTMLElement {
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

const Url = defineComponent({
	setup() {
		const page = readPage();
		return () => h("p", page.url);
	},
});

describe("photon/vue > usePage", () => {
	it("follows the page on screen through a visit", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				jsonPage({ component: "Home", url, props: {} }),
			),
		);
		const target = mountPage(Url, {
			component: "Home",
			framework: "vue",
			url: "/start",
			props: {},
		});
		expect(target.textContent).toBe("/start");
		await router.visit("/next");
		await nextTick();
		expect(target.textContent).toBe("/next");
	});

	it("reads the page from PhotonPage on the server, where there is no router", async () => {
		const page: PhotonPageData = {
			component: "Home",
			framework: "vue",
			url: "/server",
			props: {},
		};
		const html = await renderToString(
			createSSRApp({ render: () => h(PhotonPage, { page }, () => h(Url)) }),
		);
		expect(html).toContain("/server");
	});
});

const Stats = defineComponent({
	props: { stats: { type: Number, required: false } },
	setup(props) {
		return () =>
			h(
				Deferred,
				{ data: "stats" },
				{
					fallback: () => h("p", "loading"),
					rescue: () => h("p", "unavailable"),
					default: ({ reloading }: { reloading: boolean }) =>
						h(
							"p",
							`stats ${String(props.stats)}${reloading ? " (reloading)" : ""}`,
						),
				},
			);
	},
});

describe("photon/vue > Deferred", () => {
	it("shows the fallback until the deferred group arrives", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonPage({ component: "Home", url: "/start", props: { stats: 42 } }),
			),
		);
		const target = mountPage(Stats, {
			component: "Home",
			framework: "vue",
			url: "/start",
			props: {},
			deferredProps: { default: ["stats"] },
		});
		expect(target.textContent).toBe("loading");
		await vi.waitFor(async () => {
			await nextTick();
			expect(target.textContent).toBe("stats 42");
		});
	});

	it("says it is reloading while a partial reload asks for its props again", async () => {
		let release: (() => void) | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return jsonPage({ component: "Home", url: "/", props: { stats: 43 } });
			}),
		);
		history.replaceState(null, "", "/");
		const target = mountPage(Stats, {
			component: "Home",
			framework: "vue",
			url: "/",
			props: { stats: 42 },
		});
		await nextTick();
		const reload = router.reload({ only: ["stats"] });
		await vi.waitFor(() => expect(release).toBeDefined());
		await nextTick();
		expect(target.textContent).toBe("stats 42 (reloading)");
		release?.();
		await reload;
		await nextTick();
		expect(target.textContent).toBe("stats 43");
	});

	it("shows the rescue when the server rescued its prop", () => {
		const target = mountPage(Stats, {
			component: "Home",
			framework: "vue",
			url: "/start",
			props: { stats: 0 },
			rescuedProps: ["stats"],
		});
		expect(target.textContent).toBe("unavailable");
	});
});
