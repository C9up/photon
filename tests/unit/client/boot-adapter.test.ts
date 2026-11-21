/**
 * @vitest-environment jsdom
 */

/**
 * An application's own adapter: `bootPage()` with a `mount` of its own, for a
 * framework photon does not bundle (aurora's). The router drives its visits
 * as it drives React's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	bootPage,
	hydrate,
	type PhotonAdapterHandle,
	router,
} from "../../../src/client/hydrate.js";

function page(component: string, url: string, props: Record<string, unknown>) {
	return { component, props, url, framework: "aurora", version: "v1" };
}

beforeEach(() => {
	document.documentElement.innerHTML = `
    <main id="aurora-root">SSR</main>
    <script type="application/json" id="photon-data">${JSON.stringify(page("Home", "/", { n: 1 }))}</script>
  `;
	delete document.documentElement.dataset.photonRouterInstalled;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("photon/client > bootPage with an application's adapter", () => {
	it("mounts the first page and hands each visit's page to the adapter", async () => {
		const updates: Array<[unknown, Record<string, unknown>]> = [];
		const handle: PhotonAdapterHandle = {
			update: (Component, props) => updates.push([Component, props]),
			unmount: () => {},
		};
		const mounted: unknown[] = [];
		await bootPage({
			target: "#aurora-root",
			resolveComponent: async (name) => ({ default: `module:${name}` }),
			mount: async (target, Component, data) => {
				mounted.push([target?.id, Component, data.framework, data.props]);
				return handle;
			},
		});
		expect(mounted).toEqual([
			["aurora-root", "module:Home", "aurora", { n: 1 }],
		]);

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify(page("Orders", "/orders", { ids: [7] })),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					),
			),
		);
		await router.visit("/orders");
		expect(updates).toEqual([["module:Orders", { ids: [7] }]]);
		expect(location.pathname).toBe("/orders");
	});

	it("still refuses, through hydrate(), a framework photon does not bundle", async () => {
		await expect(
			hydrate({
				resolveComponent: async () => ({ default: {} }),
				target: "#aurora-root",
			}),
		).rejects.toMatchObject({
			code: "E_PHOTON_HYDRATION_UNSUPPORTED_FRAMEWORK",
		});
	});
});
