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
	vi.doUnmock("svelte");
	vi.resetModules();
});

describe("photon/client/adapters/svelte", () => {
	it("hydrate calls svelte.hydrate(Component, { target, props })", async () => {
		const hydrateFn = vi.fn(() => ({ id: "instance-1" }));
		vi.doMock("svelte", () => ({
			hydrate: hydrateFn,
			mount: vi.fn(),
			unmount: vi.fn(),
		}));

		const { svelteAdapter } = await import(
			"../../../../src/client/adapters/svelte.js"
		);
		const target = defined(document.getElementById("app"));
		await svelteAdapter.hydrate(target, "PageSvelte", { color: "red" });

		expect(hydrateFn).toHaveBeenCalledTimes(1);
		const call = hydrateFn.mock.calls[0] as [
			unknown,
			{ target: Element; props: unknown },
		];
		expect(call[0]).toBe("PageSvelte");
		expect(call[1].target).toBe(target);
		expect(call[1].props).toEqual({ color: "red" });
	});

	it("update unmounts the previous instance and mounts the next one", async () => {
		const hydrateFn = vi.fn(() => ({ id: "a" }));
		const mountFn = vi.fn(() => ({ id: "b" }));
		const unmountFn = vi.fn();
		vi.doMock("svelte", () => ({
			hydrate: hydrateFn,
			mount: mountFn,
			unmount: unmountFn,
		}));

		const { svelteAdapter } = await import(
			"../../../../src/client/adapters/svelte.js"
		);
		const target = defined(document.getElementById("app"));
		const handle = await svelteAdapter.hydrate(target, "A", { v: 1 });
		handle.update("B", { v: 2 });

		expect(unmountFn).toHaveBeenCalledWith({ id: "a" });
		expect(mountFn).toHaveBeenCalledTimes(1);
		const mountCall = mountFn.mock.calls[0] as [
			unknown,
			{ target: Element; props: unknown },
		];
		expect(mountCall[0]).toBe("B");
		expect(mountCall[1].props).toEqual({ v: 2 });
	});

	it("throws when the svelte module lacks `hydrate`/`unmount` (realistic Svelte 4 shape)", async () => {
		// Realistic Svelte 4 surface: the module exposes a class-style component
		// constructor as the default export and has NO named `hydrate` / `unmount`
		// exports. vitest 4's mock validator requires the keys to be present, so
		// we declare them with realistic falsy types (functions in `default`,
		// undefined for the v5-only exports the adapter probes).
		class FakeSvelte4Component {
			constructor(_opts: unknown) {}
		}
		vi.doMock("svelte", () => ({
			default: FakeSvelte4Component,
			hydrate: undefined,
			mount: undefined,
			unmount: undefined,
		}));

		const { svelteAdapter } = await import(
			"../../../../src/client/adapters/svelte.js"
		);
		await expect(
			svelteAdapter.hydrate(defined(document.getElementById("app")), "C", {}),
		).rejects.toThrow(/Svelte 5/i);
	});

	it("update is a no-op after unmount (no double-mount)", async () => {
		const hydrateFn = vi.fn(() => ({ id: "x" }));
		const mountFn = vi.fn(() => ({ id: "y" }));
		const unmountFn = vi.fn();
		vi.doMock("svelte", () => ({
			hydrate: hydrateFn,
			mount: mountFn,
			unmount: unmountFn,
		}));

		const { svelteAdapter } = await import(
			"../../../../src/client/adapters/svelte.js"
		);
		const handle = await svelteAdapter.hydrate(
			defined(document.getElementById("app")),
			"A",
			{},
		);
		handle.unmount();
		// After teardown, update() must NOT mount a fresh instance — mirrors
		// the React adapter's `if (!root) return` guard.
		handle.update("B", {});
		expect(mountFn).not.toHaveBeenCalled();
	});

	it("unmount tears down the active instance and short-circuits double-unmount", async () => {
		const unmountFn = vi.fn();
		vi.doMock("svelte", () => ({
			hydrate: () => ({ id: "x" }),
			mount: vi.fn(),
			unmount: unmountFn,
		}));

		const { svelteAdapter } = await import(
			"../../../../src/client/adapters/svelte.js"
		);
		const handle = await svelteAdapter.hydrate(
			defined(document.getElementById("app")),
			"C",
			{},
		);
		handle.unmount();
		handle.unmount();
		expect(unmountFn).toHaveBeenCalledTimes(1);
	});
});
