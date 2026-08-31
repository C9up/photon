/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hydrate, PhotonClientError } from "../../../src/client/hydrate.js";

interface PageDataInit {
	component?: string | null;
	props?: unknown;
	url?: string | null;
	framework?: string | null;
}

function setupDom(opts: PageDataInit = {}, includeTarget = true): void {
	const data: Record<string, unknown> = {};
	if (opts.component !== null) data["component"] = opts.component ?? "Home";
	if (opts.props !== null) data["props"] = opts.props ?? { greeting: "hi" };
	if (opts.url !== null) data["url"] = opts.url ?? "/";
	if (opts.framework !== null) data["framework"] = opts.framework ?? "react";

	document.documentElement.innerHTML = `
    ${includeTarget ? '<div id="app">SSR</div>' : ""}
    <script type="application/json" id="photon-data">${JSON.stringify(data)}</script>
  `;
}

function setRawPhotonData(rawText: string): void {
	document.documentElement.innerHTML = `
    <div id="app">SSR</div>
    <script type="application/json" id="photon-data">${rawText}</script>
  `;
}

beforeEach(() => {
	document.documentElement.innerHTML = "";
	// Reset router-installed flag (set on documentElement.dataset).
	delete document.documentElement.dataset["photonRouterInstalled"];
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("photon/client > hydrate — happy path", () => {
	it("dispatches to the React adapter when framework=react and fires onHydrated AFTER hydrateRoot completes", async () => {
		const callOrder: string[] = [];
		const reactHydrate = vi.fn();
		const reactCreateElement = vi.fn((type: unknown, props: unknown) => ({
			type,
			props,
		}));
		vi.doMock("react-dom/client", () => ({
			hydrateRoot: (target: Element, node: unknown) => {
				callOrder.push("hydrateRoot");
				reactHydrate(target, node);
				return { render: vi.fn(), unmount: vi.fn() };
			},
		}));
		vi.doMock("react", () => ({ createElement: reactCreateElement }));

		setupDom({ framework: "react", component: "Home", props: { x: 1 } });
		const Component = { name: "HomeComponent" };
		const onHydrated = vi.fn(() => {
			callOrder.push("onHydrated");
		});
		await hydrate({
			resolveComponent: async () => ({ default: Component }),
			onHydrated,
		});

		expect(reactCreateElement).toHaveBeenCalledWith(Component, { x: 1 });
		expect(reactHydrate).toHaveBeenCalledTimes(1);
		expect(reactHydrate.mock.calls[0]?.[0]).toBe(
			document.getElementById("app"),
		);
		expect(onHydrated).toHaveBeenCalledTimes(1);
		// AC: "fires exactly once after the adapter resolves" — assert ordering.
		expect(callOrder).toEqual(["hydrateRoot", "onHydrated"]);

		vi.doUnmock("react-dom/client");
		vi.doUnmock("react");
	});

	it("dispatches to the Vue adapter when framework=vue", async () => {
		const vueMount = vi.fn();
		vi.doMock("vue", () => ({
			createSSRApp: (_root: unknown, _props: unknown) => ({
				mount: vueMount,
				unmount: vi.fn(),
			}),
		}));

		setupDom({ framework: "vue", component: "About", props: { title: "Hi" } });
		await hydrate({
			resolveComponent: async () => ({ default: { name: "AboutComponent" } }),
		});
		expect(vueMount).toHaveBeenCalledTimes(1);
		expect(vueMount.mock.calls[0]?.[0]).toBe(document.getElementById("app"));

		vi.doUnmock("vue");
	});

	it("dispatches to the Svelte adapter when framework=svelte", async () => {
		const svelteHydrate = vi.fn(() => ({ id: "svelte-instance" }));
		vi.doMock("svelte", () => ({
			hydrate: svelteHydrate,
			mount: vi.fn(),
			unmount: vi.fn(),
		}));

		setupDom({ framework: "svelte" });
		await hydrate({
			resolveComponent: async () => ({ default: { name: "C" } }),
		});
		expect(svelteHydrate).toHaveBeenCalledTimes(1);

		vi.doUnmock("svelte");
	});
});

describe("photon/client > hydrate — error paths", () => {
	it("throws E_PHOTON_HYDRATION_NO_DATA when the script block is absent", async () => {
		document.documentElement.innerHTML = '<div id="app">SSR</div>';
		await expect(
			hydrate({ resolveComponent: async () => ({ default: {} }) }),
		).rejects.toMatchObject({
			code: "E_PHOTON_HYDRATION_NO_DATA",
		});
	});

	it("throws E_PHOTON_HYDRATION_BAD_DATA when the JSON is malformed", async () => {
		setRawPhotonData("{not-json}");
		await expect(
			hydrate({ resolveComponent: async () => ({ default: {} }) }),
		).rejects.toMatchObject({
			code: "E_PHOTON_HYDRATION_BAD_DATA",
		});
	});

	it("throws E_PHOTON_HYDRATION_BAD_DATA when framework field is missing", async () => {
		setRawPhotonData(
			JSON.stringify({ component: "Home", props: {}, url: "/" }),
		);
		await expect(
			hydrate({ resolveComponent: async () => ({ default: {} }) }),
		).rejects.toMatchObject({
			code: "E_PHOTON_HYDRATION_BAD_DATA",
		});
	});

	it("throws E_PHOTON_HYDRATION_UNSUPPORTED_FRAMEWORK on unknown framework value", async () => {
		setRawPhotonData(
			JSON.stringify({
				component: "Home",
				props: {},
				url: "/",
				framework: "angular",
			}),
		);
		await expect(
			hydrate({ resolveComponent: async () => ({ default: {} }) }),
		).rejects.toMatchObject({
			code: "E_PHOTON_HYDRATION_UNSUPPORTED_FRAMEWORK",
		});
	});

	it("throws E_PHOTON_HYDRATION_BAD_DATA when framework is non-string (number)", async () => {
		setRawPhotonData(
			JSON.stringify({ component: "Home", props: {}, url: "/", framework: 42 }),
		);
		await expect(
			hydrate({ resolveComponent: async () => ({ default: {} }) }),
		).rejects.toMatchObject({ code: "E_PHOTON_HYDRATION_BAD_DATA" });
	});

	it("throws E_PHOTON_HYDRATION_BAD_DATA when component is empty string", async () => {
		setRawPhotonData(
			JSON.stringify({
				component: "",
				props: {},
				url: "/",
				framework: "react",
			}),
		);
		await expect(
			hydrate({ resolveComponent: async () => ({ default: {} }) }),
		).rejects.toMatchObject({
			code: "E_PHOTON_HYDRATION_BAD_DATA",
		});
	});

	it("throws E_PHOTON_HYDRATION_BAD_DATA when props is an array", async () => {
		setRawPhotonData(
			JSON.stringify({
				component: "Home",
				props: [1, 2, 3],
				url: "/",
				framework: "react",
			}),
		);
		await expect(
			hydrate({ resolveComponent: async () => ({ default: {} }) }),
		).rejects.toMatchObject({
			code: "E_PHOTON_HYDRATION_BAD_DATA",
		});
	});

	it("throws E_PHOTON_HYDRATION_BAD_DATA when props is null", async () => {
		setRawPhotonData(
			JSON.stringify({
				component: "Home",
				props: null,
				url: "/",
				framework: "react",
			}),
		);
		await expect(
			hydrate({ resolveComponent: async () => ({ default: {} }) }),
		).rejects.toMatchObject({
			code: "E_PHOTON_HYDRATION_BAD_DATA",
		});
	});

	it("throws E_PHOTON_HYDRATION_NO_TARGET when #app is missing", async () => {
		setupDom({}, false);
		await expect(
			hydrate({ resolveComponent: async () => ({ default: {} }) }),
		).rejects.toMatchObject({
			code: "E_PHOTON_HYDRATION_NO_TARGET",
		});
	});

	it("propagates resolveComponent rejection with cause", async () => {
		setupDom({ framework: "react" });
		vi.doMock("react-dom/client", () => ({
			hydrateRoot: () => ({ render: vi.fn(), unmount: vi.fn() }),
		}));
		vi.doMock("react", () => ({ createElement: vi.fn() }));

		const original = new Error("module 404");
		await expect(
			hydrate({
				resolveComponent: async () => {
					throw original;
				},
			}),
		).rejects.toThrow("module 404");

		vi.doUnmock("react-dom/client");
		vi.doUnmock("react");
	});

	it("warns and short-circuits on double hydrate of the same target", async () => {
		vi.doMock("react-dom/client", () => ({
			hydrateRoot: () => ({ render: vi.fn(), unmount: vi.fn() }),
		}));
		vi.doMock("react", () => ({ createElement: vi.fn() }));
		setupDom({ framework: "react" });

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await hydrate({ resolveComponent: async () => ({ default: {} }) });
		await hydrate({ resolveComponent: async () => ({ default: {} }) });

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("hydrate() called twice");

		vi.doUnmock("react-dom/client");
		vi.doUnmock("react");
	});

	it("replaces the initial history state with photonData on success", async () => {
		vi.doMock("react-dom/client", () => ({
			hydrateRoot: () => ({ render: vi.fn(), unmount: vi.fn() }),
		}));
		vi.doMock("react", () => ({ createElement: vi.fn() }));
		setupDom({ framework: "react", url: "/dashboard" });

		const replaceState = vi.spyOn(history, "replaceState");
		await hydrate({ resolveComponent: async () => ({ default: {} }) });

		expect(replaceState).toHaveBeenCalledTimes(1);
		const [state, , url] = replaceState.mock.calls[0] as [
			unknown,
			string,
			string,
		];
		expect((state as { photonData: { url: string } }).photonData.url).toBe(
			"/dashboard",
		);
		expect(url).toBe("/dashboard");

		vi.doUnmock("react-dom/client");
		vi.doUnmock("react");
	});

	it("PhotonClientError exposes a code and an instanceof Error chain", () => {
		const err = new PhotonClientError("E_PHOTON_HYDRATION_BAD_DATA", "msg", {
			hint: "h",
		});
		expect(err.code).toBe("E_PHOTON_HYDRATION_BAD_DATA");
		expect(err.hint).toBe("h");
		expect(err.name).toBe("PhotonClientError");
		expect(err instanceof Error).toBe(true);
	});
});
