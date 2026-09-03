/**
 * @vitest-environment jsdom
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import { hydrate } from "../../../src/client/hydrate.js";
import type { ResolveComponent } from "../../../src/client/router.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}




interface RouterTestState {
	reactHydrate: Mock<(target: Element, node: unknown) => void>;
	reactRender: Mock<() => void>;
	reactUnmount: Mock<() => void>;
	resolveComponent: Mock<ResolveComponent>;
}

async function bootHydratedReactPage(
	initialUrl = "/start",
): Promise<RouterTestState> {
	const state: RouterTestState = {
		reactHydrate: vi.fn<(target: Element, node: unknown) => void>(),
		reactRender: vi.fn<() => void>(),
		reactUnmount: vi.fn<() => void>(),
		resolveComponent: vi.fn<ResolveComponent>(async (name) => ({
			default: { __name: name },
		})),
	};

	vi.doMock("react-dom/client", () => ({
		hydrateRoot: (target: Element, node: unknown) => {
			state.reactHydrate(target, node);
			return { render: state.reactRender, unmount: state.reactUnmount };
		},
	}));
	vi.doMock("react", () => ({
		createElement: (type: unknown, props: unknown) => ({ type, props }),
	}));

	document.documentElement.innerHTML = `
    <div id="app">SSR</div>
    <script type="application/json" id="photon-data">${JSON.stringify({
			component: "Home",
			props: { x: 1 },
			url: initialUrl,
			framework: "react",
		})}</script>
  `;

	await hydrate({ resolveComponent: state.resolveComponent });
	return state;
}

function createAnchor(opts: {
	href: string;
	target?: string;
	download?: boolean;
	dataPhoton?: string;
}): HTMLAnchorElement {
	const a = document.createElement("a");
	a.setAttribute("href", opts.href);
	if (opts.target) a.setAttribute("target", opts.target);
	if (opts.download) a.setAttribute("download", "");
	if (opts.dataPhoton) a.dataset["photon"] = opts.dataPhoton;
	document.body.appendChild(a);
	return a;
}

function dispatchClick(
	el: HTMLElement,
	init: Partial<{
		button: number;
		ctrlKey: boolean;
		metaKey: boolean;
		shiftKey: boolean;
		altKey: boolean;
	}> = {},
): MouseEvent {
	const event = new MouseEvent("click", {
		bubbles: true,
		cancelable: true,
		button: init.button ?? 0,
		ctrlKey: init.ctrlKey ?? false,
		metaKey: init.metaKey ?? false,
		shiftKey: init.shiftKey ?? false,
		altKey: init.altKey ?? false,
	});
	el.dispatchEvent(event);
	return event;
}

beforeEach(() => {
	document.documentElement.innerHTML = "";
	delete document.documentElement.dataset["photonRouterInstalled"];
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.doUnmock("react-dom/client");
	vi.doUnmock("react");
});

describe("photon/client > router — interception", () => {
	it("intercepts a same-origin internal anchor and fetches with X-Photon header", async () => {
		const state = await bootHydratedReactPage();
		const anchor = createAnchor({ href: "/orders" });

		const fetchMock = vi.fn(
			async (_url: string, _init: RequestInit) =>
				new Response(
					JSON.stringify({
						component: "Orders",
						props: { ids: [1] },
						url: "/orders",
						framework: "react",
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const pushState = vi.spyOn(history, "pushState");

		const event = dispatchClick(anchor);

		// Allow the async navigate() to settle.
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(event.defaultPrevented).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = defined(fetchMock.mock.calls[0]);
		expect(url).toBe("/orders");
		const headers = init.headers;
		expect(
			headers instanceof Headers
				? headers.get("x-photon")
				: Array.isArray(headers)
					? headers.find(([name]) => name === "x-photon")?.[1]
					: headers?.["x-photon"],
		).toBe("true");
		expect(init.credentials).toBe("same-origin");

		expect(state.resolveComponent).toHaveBeenCalledWith("Orders");
		expect(state.reactRender).toHaveBeenCalledTimes(1);
		expect(pushState).toHaveBeenCalledTimes(1);
	});

	it("does not intercept clicks with target=_blank", async () => {
		await bootHydratedReactPage();
		const anchor = createAnchor({ href: "/x", target: "_blank" });
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const event = dispatchClick(anchor);
		await new Promise((r) => setTimeout(r, 0));

		expect(event.defaultPrevented).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not intercept on Ctrl-click", async () => {
		await bootHydratedReactPage();
		const anchor = createAnchor({ href: "/x" });
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const event = dispatchClick(anchor, { ctrlKey: true });
		await new Promise((r) => setTimeout(r, 0));

		expect(event.defaultPrevented).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not intercept on Meta-click", async () => {
		await bootHydratedReactPage();
		const anchor = createAnchor({ href: "/x" });
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		dispatchClick(anchor, { metaKey: true });
		await new Promise((r) => setTimeout(r, 0));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not intercept middle-click (button=1)", async () => {
		await bootHydratedReactPage();
		const anchor = createAnchor({ href: "/x" });
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		dispatchClick(anchor, { button: 1 });
		await new Promise((r) => setTimeout(r, 0));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not intercept anchors with the [download] attribute", async () => {
		await bootHydratedReactPage();
		const anchor = createAnchor({ href: "/file.pdf", download: true });
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		dispatchClick(anchor);
		await new Promise((r) => setTimeout(r, 0));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does not intercept anchors opted out via data-photon="external"', async () => {
		await bootHydratedReactPage();
		const anchor = createAnchor({ href: "/x", dataPhoton: "external" });
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		dispatchClick(anchor);
		await new Promise((r) => setTimeout(r, 0));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not intercept cross-origin anchors", async () => {
		await bootHydratedReactPage();
		const anchor = createAnchor({ href: "https://other-host.example/page" });
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		dispatchClick(anchor);
		await new Promise((r) => setTimeout(r, 0));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not intercept mailto: / tel: / javascript: / data: / blob: anchors", async () => {
		await bootHydratedReactPage();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		for (const href of [
			"mailto:a@b.com",
			"tel:+33123456789",
			"javascript:void(0)",
			"data:text/html,<h1>x</h1>",
			"blob:http://localhost/abc",
		]) {
			document.body.innerHTML = "";
			const a = createAnchor({ href });
			dispatchClick(a);
			await new Promise((r) => setTimeout(r, 0));
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("photon/client > router — fallback paths", () => {
	it("falls back to full reload on non-2xx response", async () => {
		await bootHydratedReactPage();
		const anchor = createAnchor({ href: "/missing" });

		const fetchMock = vi.fn(async () => new Response("", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		// Spy on location.href setter via window proxy.
		const hrefSetter = vi.fn();
		const originalLocation = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: new Proxy(originalLocation, {
				set(target, prop, value) {
					if (prop === "href") {
						hrefSetter(value);
						return true;
					}
					(target as unknown as Record<string, unknown>)[prop as string] =
						value;
					return true;
				},
			}),
		});

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		dispatchClick(anchor);
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(hrefSetter).toHaveBeenCalledWith("/missing");
		expect(errSpy).toHaveBeenCalled();

		Object.defineProperty(window, "location", {
			configurable: true,
			value: originalLocation,
		});
	});

	it("falls back to full reload when response Content-Type is not JSON", async () => {
		await bootHydratedReactPage();
		const anchor = createAnchor({ href: "/html-page" });

		const fetchMock = vi.fn(
			async () =>
				new Response("<!DOCTYPE html><html></html>", {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const hrefSetter = vi.fn();
		const originalLocation = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: new Proxy(originalLocation, {
				set(target, prop, value) {
					if (prop === "href") {
						hrefSetter(value);
						return true;
					}
					(target as unknown as Record<string, unknown>)[prop as string] =
						value;
					return true;
				},
			}),
		});

		dispatchClick(anchor);
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(hrefSetter).toHaveBeenCalledWith("/html-page");

		Object.defineProperty(window, "location", {
			configurable: true,
			value: originalLocation,
		});
	});

	it("falls back to full reload when JSON shape is wrong", async () => {
		await bootHydratedReactPage();
		const anchor = createAnchor({ href: "/bad" });

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							component: "X",
							props: {},
							url: "/bad" /* missing framework */,
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					),
			),
		);

		const hrefSetter = vi.fn();
		const originalLocation = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: new Proxy(originalLocation, {
				set(target, prop, value) {
					if (prop === "href") {
						hrefSetter(value);
						return true;
					}
					(target as unknown as Record<string, unknown>)[prop as string] =
						value;
					return true;
				},
			}),
		});

		dispatchClick(anchor);
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(hrefSetter).toHaveBeenCalledWith("/bad");

		Object.defineProperty(window, "location", {
			configurable: true,
			value: originalLocation,
		});
	});
});

describe("photon/client > router — popstate", () => {
	it("restores via adapter.update when state.photonData is valid", async () => {
		const state = await bootHydratedReactPage("/initial");

		const popPageData = {
			component: "Back",
			props: { foo: "bar" },
			url: "/initial",
			framework: "react" as const,
		};
		const event = new PopStateEvent("popstate", {
			state: { photonData: popPageData },
		});
		window.dispatchEvent(event);
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(state.resolveComponent).toHaveBeenCalledWith("Back");
		expect(state.reactRender).toHaveBeenCalledTimes(1);
	});

	it("falls back to location.reload when popstate has no photonData", async () => {
		await bootHydratedReactPage("/initial");

		const reloadSpy = vi.fn();
		const originalLocation = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: {
				...originalLocation,
				reload: reloadSpy,
				origin: originalLocation.origin,
				href: originalLocation.href,
			},
		});

		const event = new PopStateEvent("popstate", { state: null });
		window.dispatchEvent(event);
		await new Promise((r) => setTimeout(r, 0));

		expect(reloadSpy).toHaveBeenCalledTimes(1);

		Object.defineProperty(window, "location", {
			configurable: true,
			value: originalLocation,
		});
	});
});

describe("photon/client > router — review hardenings (HIGH/MED patches)", () => {
	it("rejects cross-origin pageData.url and ABORTS (never navigates to it)", async () => {
		await bootHydratedReactPage();
		const anchor = createAnchor({ href: "/legit" });

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							component: "Home",
							props: {},
							// Hostile/buggy SSR points pageData.url at another origin.
							// A full reload to this URL is exactly the cross-origin
							// redirect the guard exists to prevent — navigation must
							// be aborted, NOT followed.
							url: "https://evil.example/admin",
							framework: "react",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		);

		const hrefSetter = vi.fn();
		const originalLocation = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: new Proxy(originalLocation, {
				set(target, prop, value) {
					if (prop === "href") {
						hrefSetter(value);
						return true;
					}
					(target as unknown as Record<string, unknown>)[prop as string] =
						value;
					return true;
				},
			}),
		});

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		dispatchClick(anchor);
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		// The crux: location.href is NEVER set to the malicious URL. The
		// guard logs and aborts; the user stays on the current page.
		expect(hrefSetter).not.toHaveBeenCalled();
		expect(errSpy).toHaveBeenCalled();

		Object.defineProperty(window, "location", {
			configurable: true,
			value: originalLocation,
		});
	});

	it("falls back to full reload when adapter.update throws", async () => {
		const state = await bootHydratedReactPage("/start");
		// Override the React render mock to throw on the next call.
		state.reactRender.mockImplementationOnce(() => {
			throw new Error("simulated render failure");
		});

		const anchor = createAnchor({ href: "/orders" });
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							component: "Orders",
							props: {},
							url: "/orders",
							framework: "react",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		);

		const hrefSetter = vi.fn();
		const originalLocation = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: new Proxy(originalLocation, {
				set(target, prop, value) {
					if (prop === "href") {
						hrefSetter(value);
						return true;
					}
					(target as unknown as Record<string, unknown>)[prop as string] =
						value;
					return true;
				},
			}),
		});

		vi.spyOn(console, "error").mockImplementation(() => {});
		dispatchClick(anchor);
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(hrefSetter).toHaveBeenCalledWith("/orders");

		Object.defineProperty(window, "location", {
			configurable: true,
			value: originalLocation,
		});
	});

	it("uses replaceState (not pushState) when navigating to the current URL", async () => {
		// Boot at /current; click an anchor that resolves to the same URL.
		await bootHydratedReactPage("/current");
		// Move location to /current so the same-URL check fires.
		window.history.replaceState(window.history.state, "", "/current");

		const anchor = createAnchor({ href: "/current" });
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							component: "Home",
							props: {},
							url: "/current",
							framework: "react",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		);

		const pushSpy = vi.spyOn(history, "pushState");
		const replaceSpy = vi.spyOn(history, "replaceState");

		dispatchClick(anchor);
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(pushSpy).not.toHaveBeenCalled();
		expect(replaceSpy).toHaveBeenCalledTimes(1);
	});

	it("warns when pushState payload exceeds the soft size threshold", async () => {
		const state = await bootHydratedReactPage("/start");
		const anchor = createAnchor({ href: "/big" });

		// Build a payload that JSON-stringifies to > 100KB.
		const bigString = "a".repeat(120_000);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							component: "Big",
							props: { blob: bigString },
							url: "/big",
							framework: "react",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		);

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		dispatchClick(anchor);
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(state.reactRender).toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalled();
		const warnArg = warnSpy.mock.calls[0]?.[0] as string;
		expect(warnArg).toMatch(/640KB|history state/i);
	});

	it("ignores stale fetch responses when a newer navigation has started", async () => {
		const state = await bootHydratedReactPage("/start");
		const a1 = createAnchor({ href: "/slow" });
		const a2 = createAnchor({ href: "/fast" });

		// First fetch resolves AFTER the second one (race the scheduler).
		let resolveSlow!: (r: Response) => void;
		const slowPromise = new Promise<Response>((r) => {
			resolveSlow = r;
		});
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(() => slowPromise)
			.mockImplementationOnce(
				async () =>
					new Response(
						JSON.stringify({
							component: "Fast",
							props: {},
							url: "/fast",
							framework: "react",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			);
		vi.stubGlobal("fetch", fetchMock);

		dispatchClick(a1);
		dispatchClick(a2);

		// Let the fast navigation complete first.
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		// Now resolve the slow one — its body should be discarded because a
		// newer nav already finished.
		resolveSlow(
			new Response(
				JSON.stringify({
					component: "Slow",
					props: {},
					url: "/slow",
					framework: "react",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		// Only the FAST page rendered; the slow response was dropped.
		const slowResolveCall = state.resolveComponent.mock.calls.find(
			(c) => c[0] === "Slow",
		);
		expect(slowResolveCall).toBeUndefined();
		const fastResolveCall = state.resolveComponent.mock.calls.find(
			(c) => c[0] === "Fast",
		);
		expect(fastResolveCall).toBeDefined();
	});
});
