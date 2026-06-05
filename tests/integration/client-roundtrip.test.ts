/**
 * @vitest-environment jsdom
 *
 * End-to-end smoke: SSR HTML produced by the real PhotonRenderer is injected
 * into the jsdom document, the real `hydrate()` consumes it, a click on a
 * same-origin anchor triggers an SPA-nav fetch, and the React mock root
 * receives the swapped page-data.
 *
 * Proves the JSON-escape round-trip from `escapeScriptJson` (server-side) to
 * `JSON.parse` (client-side) works, the adapter dispatch wires correctly, and
 * the click interceptor + adapter.update + history.pushState chain is sound.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotonRenderer } from "../../src/PhotonRenderer.js";

beforeEach(() => {
	document.documentElement.innerHTML = "";
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.doUnmock("react-dom/client");
	vi.doUnmock("react");
});

describe("photon/client > integration roundtrip", () => {
	it("SSR → hydrate → click → swap end-to-end", async () => {
		// 1. Render the SSR HTML the same way a real Ream app would.
		const renderer = new PhotonRenderer({
			framework: "react",
			entryClient: "resources/app.tsx",
			entryServer: "resources/ssr.tsx",
		});
		const initial = await renderer.render("Home", { greeting: "hi" }, "/start");
		document.documentElement.innerHTML = initial.html;

		// 2. Mock the React runtime.
		const renderSpy = vi.fn();
		const hydrateRootSpy = vi.fn(() => ({
			render: renderSpy,
			unmount: vi.fn(),
		}));
		const createElementSpy = vi.fn((type, props) => ({ type, props }));
		vi.doMock("react-dom/client", () => ({ hydrateRoot: hydrateRootSpy }));
		vi.doMock("react", () => ({ createElement: createElementSpy }));

		// Late-import after mocks so the dynamic import sees the mocked modules.
		const { hydrate } = await import("../../src/client/hydrate.js");

		const components: Record<string, unknown> = {
			Home: { __name: "Home" },
			Orders: { __name: "Orders" },
		};
		const resolveComponent = vi.fn(async (name: string) => ({
			default: components[name],
		}));

		await hydrate({ resolveComponent });

		// 3. Initial hydrate fired.
		expect(hydrateRootSpy).toHaveBeenCalledTimes(1);
		expect(createElementSpy).toHaveBeenCalledWith(
			{ __name: "Home" },
			{ greeting: "hi" },
		);

		// 4. SPA-nav: simulate a click on a same-origin link.
		const a = document.createElement("a");
		a.setAttribute("href", "/orders");
		a.textContent = "Orders";
		document.body.appendChild(a);

		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						component: "Orders",
						props: { ids: [10, 20] },
						url: "/orders",
						framework: "react",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const pushSpy = vi.spyOn(history, "pushState");

		a.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
		);
		// Microtask drain.
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		// 5. The router fetched with X-Photon, resolveComponent fired, render swap landed.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(resolveComponent).toHaveBeenCalledWith("Orders");
		expect(renderSpy).toHaveBeenCalledTimes(1);
		expect(renderSpy.mock.calls[0]?.[0]).toEqual({
			type: { __name: "Orders" },
			props: { ids: [10, 20] },
		});
		expect(pushSpy).toHaveBeenCalledTimes(1);
	});

	it("escapes HTML-tag characters in props through the SSR → JSON.parse chain", async () => {
		const renderer = new PhotonRenderer({
			framework: "react",
			entryClient: "app.tsx",
			entryServer: "ssr.tsx",
		});
		// The user's "props" intentionally contain an HTML-tag-like substring.
		const dangerous = "<script>alert(1)</script>";
		const initial = await renderer.render("Page", { html: dangerous }, "/");
		document.documentElement.innerHTML = initial.html;

		vi.doMock("react-dom/client", () => ({
			hydrateRoot: () => ({ render: vi.fn(), unmount: vi.fn() }),
		}));
		let captured: Record<string, unknown> | undefined;
		vi.doMock("react", () => ({
			createElement: (_type: unknown, props: Record<string, unknown>) => {
				captured = props;
				return { type: _type, props };
			},
		}));

		const { hydrate } = await import("../../src/client/hydrate.js");
		await hydrate({ resolveComponent: async () => ({ default: {} }) });

		expect(captured?.["html"]).toBe(dangerous);
	});
});
