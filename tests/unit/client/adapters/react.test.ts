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
	vi.doUnmock("react-dom/client");
	vi.doUnmock("react");
	vi.resetModules();
});

describe("photon/client/adapters/react", () => {
	it("hydrate calls hydrateRoot with createElement(Component, props)", async () => {
		const hydrateRoot = vi.fn((_target: Element, _node: unknown) => ({
			render: vi.fn(),
			unmount: vi.fn(),
		}));
		const createElement = vi.fn((type, props) => ({ type, props }));
		vi.doMock("react-dom/client", () => ({ hydrateRoot }));
		vi.doMock("react", () => ({ createElement }));

		const { reactAdapter } = await import(
			"../../../../src/client/adapters/react.js"
		);
		const target = defined(document.getElementById("app"));
		await reactAdapter.hydrate(target, "PageComponent", { x: 1 });

		expect(createElement).toHaveBeenCalledWith("PageComponent", { x: 1 });
		expect(hydrateRoot).toHaveBeenCalledTimes(1);
		expect(hydrateRoot.mock.calls[0]?.[0]).toBe(target);
	});

	it("update re-renders the root with the new component", async () => {
		const render = vi.fn();
		vi.doMock("react-dom/client", () => ({
			hydrateRoot: () => ({ render, unmount: vi.fn() }),
		}));
		vi.doMock("react", () => ({
			createElement: (t: unknown, p: unknown) => ({ t, p }),
		}));

		const { reactAdapter } = await import(
			"../../../../src/client/adapters/react.js"
		);
		const handle = await reactAdapter.hydrate(
			defined(document.getElementById("app")),
			"A",
			{},
		);
		handle.update("B", { y: 2 });

		expect(render).toHaveBeenCalledTimes(1);
		expect(render.mock.calls[0]?.[0]).toEqual({ t: "B", p: { y: 2 } });
	});

	it("unmount calls root.unmount and short-circuits subsequent updates", async () => {
		const unmount = vi.fn();
		const render = vi.fn();
		vi.doMock("react-dom/client", () => ({
			hydrateRoot: () => ({ render, unmount }),
		}));
		vi.doMock("react", () => ({
			createElement: (t: unknown, p: unknown) => ({ t, p }),
		}));

		const { reactAdapter } = await import(
			"../../../../src/client/adapters/react.js"
		);
		const handle = await reactAdapter.hydrate(
			defined(document.getElementById("app")),
			"A",
			{},
		);
		handle.unmount();
		handle.update("B", {});

		expect(unmount).toHaveBeenCalledTimes(1);
		expect(render).not.toHaveBeenCalled();
	});
});
