// @vitest-environment jsdom

/**
 * `createPhotonApp` and `App` from `@c9up/photon/react`: the app an SSR entry
 * renders and a client entry mounts, the way `createInertiaApp` does. The
 * server render runs first — nothing has primed the router yet, as on a real
 * server.
 */

import {
	act,
	createContext,
	createElement,
	type ReactNode,
	useContext,
} from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PhotonPageData } from "../../../src/client/hydrate.js";
import {
	App,
	createPhotonApp,
	type SetupOptions,
	usePage,
} from "../../../src/client/react/index.js";
import { router } from "../../../src/client/router.js";

beforeAll(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function Home(props: Record<string, unknown>): ReactNode {
	const page = usePage();
	return createElement(
		"p",
		null,
		`home ${String(props.greeting)} at ${page.url}`,
	);
}

function Orders(props: Record<string, unknown>): ReactNode {
	return createElement("p", null, `orders ${String(props.count)}`);
}

const pages: Record<string, unknown> = {
	"./pages/Home.tsx": { default: Home },
	"./pages/Orders.tsx": { default: Orders },
};
const resolve = (name: string): unknown => pages[`./pages/${name}.tsx`];

function page(overrides: Partial<PhotonPageData> = {}): PhotonPageData {
	return {
		component: "Home",
		props: { greeting: "hi" },
		url: "/start",
		framework: "react",
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
		await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
	}
	throw new Error(`never: ${what}`);
}

describe("photon/react > createPhotonApp on the server", () => {
	it("renders App for the page and returns { head, body }, the page given to usePage", async () => {
		const result = await createPhotonApp({
			page: page(),
			render: renderToString,
			resolve,
		});
		expect(result).toEqual({ head: [], body: "<p>home hi at /start</p>" });
	});

	it("renders what setup returns, App inside the app's own providers", async () => {
		const Theme = createContext("light");
		function Themed(): ReactNode {
			return createElement("p", null, useContext(Theme));
		}
		const { body } = await createPhotonApp({
			page: page({ component: "Themed" }),
			render: renderToString,
			resolve: () => Themed,
			setup: ({ App: Root, props }) =>
				createElement(
					Theme.Provider,
					{ value: "dark" },
					createElement(Root, props),
				),
		});
		expect(body).toBe("<p>dark</p>");
	});

	it("names the page resolve() does not know", async () => {
		await expect(
			createPhotonApp({
				page: page({ component: "Missing" }),
				render: renderToString,
				resolve,
			}),
		).rejects.toMatchObject({ code: "E_PHOTON_UNKNOWN_PAGE" });
	});
});

describe("photon/react > createPhotonApp in the browser", () => {
	it("hydrates the server's markup, then shows the pages the router visits", async () => {
		const data = page();
		serve("<p>home hi at /start</p>", data);
		const serverNode = document.querySelector("p");
		const error = vi.spyOn(console, "error");

		await act(async () => {
			await createPhotonApp({ resolve });
		});
		// Hydrated: the node the server rendered is the one on screen.
		expect(document.querySelector("p")).toBe(serverNode);
		expect(error).not.toHaveBeenCalled();

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
		await act(async () => {
			await router.visit("/orders");
		});
		const app = document.getElementById("app");
		await until(() => app?.textContent === "orders 3", '"orders 3"');
	});

	it("lets setup mount App itself", async () => {
		serve("", page());
		const seen: SetupOptions<HTMLElement>[] = [];
		await createPhotonApp({ resolve, setup: (options) => seen.push(options) });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.el).toBe(document.getElementById("app"));
		expect(seen[0]?.App).toBe(App);
		expect(seen[0]?.props.initialComponent).toBe(Home);
		expect(seen[0]?.props.initialPage.url).toBe("/start");
	});
});
