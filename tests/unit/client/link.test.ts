// @vitest-environment jsdom

/**
 * `Link` from `@c9up/photon/react` and `/vue`, against the real frameworks:
 * a GET link is an anchor whose click the router takes over, a mutating one
 * is a button, and a click the browser should keep — modified, or aimed at
 * another window — is left alone.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createApp, h } from "vue";
import { Link as ReactLink } from "../../../src/client/react/index.js";
import { bootRouter } from "../../../src/client/router.js";
import { Link as VueLink } from "../../../src/client/vue/index.js";

beforeAll(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root | undefined;
let unmountVue: (() => void) | undefined;

beforeEach(() => {
	fetchMock = vi.fn(
		async (url: string, _init?: RequestInit) =>
			new Response(
				JSON.stringify({
					component: "Page",
					framework: "react",
					url,
					props: {},
				}),
				{ headers: { "content-type": "application/json" } },
			),
	);
	vi.stubGlobal("fetch", fetchMock);
	bootRouter({
		target: document.body,
		adapter: { update() {}, unmount() {} },
		resolveComponent: async () => ({ default: "Page" }),
		page: { component: "Page", framework: "react", url: "/", props: {} },
	});
});

afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	unmountVue?.();
	unmountVue = undefined;
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

function renderReact(element: ReturnType<typeof createElement>): HTMLElement {
	const target = document.createElement("div");
	document.body.append(target);
	const reactRoot = createRoot(target);
	root = reactRoot;
	act(() => reactRoot.render(element));
	return target;
}

function renderVue(render: () => ReturnType<typeof h>): HTMLElement {
	const target = document.createElement("div");
	document.body.append(target);
	const app = createApp({ render });
	app.mount(target);
	unmountVue = () => app.unmount();
	return target;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe.each([
	[
		"react",
		(props: Record<string, unknown>, text: string) =>
			renderReact(createElement(ReactLink, { href: "/", ...props }, text)),
	],
	[
		"vue",
		(props: Record<string, unknown>, text: string) =>
			renderVue(() => h(VueLink, { href: "/", ...props }, () => text)),
	],
])("photon/%s > Link", (_name, render) => {
	it("is an anchor whose click the router takes over, data in the query", async () => {
		const target = render({ href: "/search", data: { q: "tea" } }, "search");
		const anchor = target.querySelector("a");
		expect(anchor?.getAttribute("href")).toBe("/search?q=tea");
		anchor?.click();
		await act(settle);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/search?q=tea");
	});

	it("is a button for a mutation, which sends its data in the body", async () => {
		const target = render(
			{ href: "/orders/1", method: "delete", data: { reason: "dup" } },
			"delete",
		);
		expect(target.querySelector("a")).toBeNull();
		const button = target.querySelector("button");
		expect(button?.getAttribute("type")).toBe("button");
		button?.click();
		await act(settle);
		const init: RequestInit | undefined = fetchMock.mock.calls[0]?.[1];
		expect(init?.method).toBe("DELETE");
		expect(init?.body).toBe('{"reason":"dup"}');
	});

	it("leaves a modified click, or one aimed at another window, to the browser", async () => {
		const target = render({ href: "/elsewhere", target: "_blank" }, "new tab");
		const anchor = target.querySelector("a");
		anchor?.click();
		const plain = render({ href: "/elsewhere" }, "plain").querySelector("a");
		plain?.dispatchEvent(
			new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
				ctrlKey: true,
			}),
		);
		await act(settle);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
