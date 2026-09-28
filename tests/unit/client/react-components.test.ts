// @vitest-environment jsdom

/**
 * `@c9up/photon/react` against the real React: the page store behind
 * `usePage`, the `PhotonPage` provider the SSR entry uses, and `Deferred`
 * following the deferred props the router loads. What needs a viewport —
 * `WhenVisible`, `InfiniteScroll` — is in `tests/browser`.
 */

import { act, type ComponentType, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PhotonPageData } from "../../../src/client/hydrate.js";
import {
	Deferred,
	type DeferredProps,
	PhotonPage,
	usePage,
} from "../../../src/client/react/index.js";
import { bootRouter, router } from "../../../src/client/router.js";

beforeAll(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

let root: Root | undefined;

afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function jsonPage(page: Record<string, unknown>): Response {
	return new Response(JSON.stringify({ framework: "react", ...page }), {
		headers: { "content-type": "application/json" },
	});
}

/** Mount `Page` as the router's page, the way the React adapter does. */
async function mountPage(
	Page: ComponentType<Record<string, unknown>>,
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
				// This test has one page component, which `resolveComponent` returns.
				update: (_component, props) => {
					reactRoot.render(createElement(Page, props));
				},
				unmount: () => reactRoot.unmount(),
			},
			resolveComponent: async () => ({ default: Page }),
			page,
		});
		reactRoot.render(createElement(Page, page.props));
	});
	return target;
}

function Url(): ReactNode {
	return createElement("p", null, usePage().url);
}

describe("photon/react > usePage", () => {
	it("follows the page on screen through a visit", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				jsonPage({ component: "Home", url, props: {} }),
			),
		);
		const target = await mountPage(Url, {
			component: "Home",
			framework: "react",
			url: "/start",
			props: {},
		});
		expect(target.textContent).toBe("/start");
		await act(() => router.visit("/next"));
		expect(target.textContent).toBe("/next");
	});

	it("reads the page from PhotonPage on the server, where there is no router", () => {
		const html = renderToString(
			createElement(
				PhotonPage,
				{
					page: {
						component: "Home",
						framework: "react",
						url: "/server",
						props: {},
					},
				},
				createElement(Url),
			),
		);
		expect(html).toContain("/server");
	});
});

function Stats(props: Record<string, unknown>): ReactNode {
	// Typed as the component's props: a render-prop child is a prop, and
	// `createElement`'s children argument only takes nodes.
	const deferred: DeferredProps = {
		data: "stats",
		fallback: createElement("p", null, "loading"),
		rescue: createElement("p", null, "unavailable"),
		children: ({ reloading }) =>
			createElement(
				"p",
				null,
				`stats ${String(props.stats)}${reloading ? " (reloading)" : ""}`,
			),
	};
	return createElement(Deferred, deferred);
}

describe("photon/react > Deferred", () => {
	it("shows the fallback until the deferred group arrives", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				await gate;
				return jsonPage({
					component: "Home",
					url: "/start",
					props: { stats: 42 },
				});
			}),
		);
		const target = await mountPage(Stats, {
			component: "Home",
			framework: "react",
			url: "/start",
			props: {},
			deferredProps: { default: ["stats"] },
		});
		expect(target.textContent).toBe("loading");
		await act(async () => {
			release?.();
			await vi.waitFor(() => expect(target.textContent).toBe("stats 42"));
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
		const target = await mountPage(Stats, {
			component: "Home",
			framework: "react",
			url: "/",
			props: { stats: 42 },
		});
		let reload: Promise<void> | undefined;
		await act(async () => {
			reload = router.reload({ only: ["stats"] });
			await vi.waitFor(() => expect(release).toBeDefined());
		});
		expect(target.textContent).toBe("stats 42 (reloading)");
		await act(async () => {
			release?.();
			await reload;
		});
		expect(target.textContent).toBe("stats 43");
	});

	it("shows the rescue when the server rescued its prop", async () => {
		const target = await mountPage(Stats, {
			component: "Home",
			framework: "react",
			url: "/start",
			props: { stats: null },
			rescuedProps: ["stats"],
		});
		expect(target.textContent).toBe("unavailable");
	});
});
