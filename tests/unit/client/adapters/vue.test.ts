/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Narrow away null without a `!` non-null assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value (#app element)");
	return value;
}

beforeEach(() => {
	document.documentElement.innerHTML = '<div id="app">SSR</div>';
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.doUnmock("vue");
	vi.resetModules();
});

describe("photon/client/adapters/vue", () => {
	it("hydrate uses createSSRApp(Component, props) then mount(target)", async () => {
		const mount = vi.fn();
		const unmount = vi.fn();
		const createSSRApp = vi.fn((_root: unknown, _props: unknown) => ({
			mount,
			unmount,
		}));
		vi.doMock("vue", () => ({ createSSRApp }));

		const { vueAdapter } = await import(
			"../../../../src/client/adapters/vue.js"
		);
		const target = defined(document.getElementById("app"));
		await vueAdapter.hydrate(target, "PageVue", { foo: "bar" });

		expect(createSSRApp).toHaveBeenCalledTimes(1);
		expect(createSSRApp.mock.calls[0]?.[0]).toBe("PageVue");
		expect(createSSRApp.mock.calls[0]?.[1]).toEqual({ foo: "bar" });
		expect(mount).toHaveBeenCalledWith(target);
	});

	it("update unmounts the previous app and creates a fresh SSR app for the new component", async () => {
		const unmounts: unknown[] = [];
		const mounts: unknown[] = [];
		const createSSRApp = vi.fn((root: unknown, props: unknown) => ({
			mount: (t: unknown) => {
				mounts.push({ root, props, t });
			},
			unmount: () => {
				unmounts.push({ root, props });
			},
		}));
		vi.doMock("vue", () => ({ createSSRApp }));

		const { vueAdapter } = await import(
			"../../../../src/client/adapters/vue.js"
		);
		const target = defined(document.getElementById("app"));
		const handle = await vueAdapter.hydrate(target, "A", { v: 1 });
		handle.update("B", { v: 2 });

		expect(createSSRApp).toHaveBeenCalledTimes(2);
		expect(unmounts).toEqual([{ root: "A", props: { v: 1 } }]);
		expect(mounts).toEqual([
			{ root: "A", props: { v: 1 }, t: target },
			{ root: "B", props: { v: 2 }, t: target },
		]);
	});

	it("unmount calls app.unmount and clears state", async () => {
		const unmount = vi.fn();
		vi.doMock("vue", () => ({
			createSSRApp: () => ({ mount: vi.fn(), unmount }),
		}));

		const { vueAdapter } = await import(
			"../../../../src/client/adapters/vue.js"
		);
		const handle = await vueAdapter.hydrate(
			defined(document.getElementById("app")),
			"A",
			{},
		);
		handle.unmount();
		expect(unmount).toHaveBeenCalledTimes(1);
	});

	it("update() after unmount() is a no-op (no resurrect into a dead target)", async () => {
		const createSSRApp = vi.fn(() => ({ mount: vi.fn(), unmount: vi.fn() }));
		vi.doMock("vue", () => ({ createSSRApp }));
		const { vueAdapter } = await import(
			"../../../../src/client/adapters/vue.js"
		);
		const handle = await vueAdapter.hydrate(
			defined(document.getElementById("app")),
			"A",
			{},
		);
		expect(createSSRApp).toHaveBeenCalledTimes(1); // initial hydrate
		handle.unmount();
		// React/Svelte guard parity: a post-unmount update must not recreate the
		// app into a torn-down target (audit 2026-06-13).
		handle.update("B", { v: 2 });
		expect(createSSRApp).toHaveBeenCalledTimes(1);
	});
});
