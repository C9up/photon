// @vitest-environment jsdom

/**
 * `createPhotonApp`, `App` and `plugin` from `@c9up/photon/vue`: the app an
 * SSR entry renders and a client entry mounts, the way `createInertiaApp`
 * does. The server render runs first — nothing has primed the router yet, as
 * on a real server.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, createSSRApp, defineComponent, h, nextTick } from "vue";
import { renderToString } from "vue/server-renderer";
import type { PhotonPageData } from "../../../src/client/hydrate.js";
import { router } from "../../../src/client/router.js";
// Aliased: the React hooks lint rule reads `use…` as a hook.
import {
	App,
	createPhotonApp,
	plugin,
	usePage as readPage,
	type SetupOptions,
} from "../../../src/client/vue/index.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const Home = defineComponent(
	(props: { greeting: string }) => {
		const page = readPage();
		return () => h("p", `home ${props.greeting} at ${page.url}`);
	},
	{ name: "HomePage", props: ["greeting"] },
);

const Orders = defineComponent(
	(props: { count: number }) => () => h("p", `orders ${props.count}`),
	{ name: "OrdersPage", props: ["count"] },
);

const pages: Record<string, unknown> = {
	"./pages/Home.vue": { default: Home },
	"./pages/Orders.vue": { default: Orders },
};
const resolve = (name: string): unknown => pages[`./pages/${name}.vue`];

function page(overrides: Partial<PhotonPageData> = {}): PhotonPageData {
	return {
		component: "Home",
		props: { greeting: "hi" },
		url: "/start",
		framework: "vue",
		...overrides,
	};
}

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

describe("photon/vue > createPhotonApp on the server", () => {
	it("renders App for the page and returns { head, body }, the page given to usePage", async () => {
		const result = await createPhotonApp({
			page: page(),
			render: renderToString,
			resolve,
		});
		expect(result).toEqual({ head: [], body: "<p>home hi at /start</p>" });
	});

	it("renders the app setup creates", async () => {
		const { body } = await createPhotonApp({
			page: page(),
			render: renderToString,
			resolve,
			setup: ({ App: Root, props, plugin: installed }) =>
				createSSRApp({ render: () => h("main", [h(Root, props)]) }).use(
					installed,
				),
		});
		expect(body).toBe("<main><p>home hi at /start</p></main>");
	});
});

describe("photon/vue > createPhotonApp in the browser", () => {
	it("hydrates the server's markup, then shows the pages the router visits", async () => {
		const data = page();
		serve("<p>home hi at /start</p>", data);
		const serverNode = document.querySelector("p");
		const warn = vi.spyOn(console, "warn");

		await createPhotonApp({ resolve });
		// Hydrated: the node the server rendered is the one on screen.
		expect(document.querySelector("p")).toBe(serverNode);
		expect(warn).not.toHaveBeenCalled();

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify(
							page({
								component: "Orders",
								props: { count: 3 },
								url: "/orders",
							}),
						),
						{ headers: { "content-type": "application/json" } },
					),
			),
		);
		await router.visit("/orders");
		await nextTick();
		const app = document.getElementById("app");
		await until(() => app?.textContent === "orders 3", '"orders 3"');
	});

	it("installs $photon and $page with the plugin", async () => {
		serve("", page());
		const seen: SetupOptions<HTMLElement>[] = [];
		await createPhotonApp({ resolve, setup: (options) => seen.push(options) });
		expect(seen[0]?.App).toBe(App);
		expect(seen[0]?.plugin).toBe(plugin);
		expect(seen[0]?.el).toBe(document.getElementById("app"));

		const Probe = defineComponent({
			name: "PlugProbe",
			render() {
				return h("p", `${this.$page?.url} ${this.$photon === router}`);
			},
		});
		const el = document.createElement("div");
		createApp(Probe).use(plugin).mount(el);
		expect(el.textContent).toBe("/start true");
	});
});
