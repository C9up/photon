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
import {
	hydrate,
	router,
	useInfiniteScrollData,
} from "../../../src/client/hydrate.js";
import type { ResolveComponent } from "../../../src/client/router.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}

/**
 * Wait until `ready()` holds, rather than for a fixed number of turns.
 *
 * A navigation fallback runs through a fetch, a response read and a rejected
 * parse before it touches `location`, and how many microtask hops that takes
 * is an implementation detail. Counting `setTimeout(0)`s guessed at it, won on
 * a fast machine, and lost on CI — where the three fallback tests failed while
 * passing everywhere else.
 */
async function waitFor(
	ready: () => boolean,
	what = "condition",
	turns = 50,
): Promise<void> {
	for (let i = 0; i < turns; i += 1) {
		if (ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`waitFor: ${what} never became true`);
}

interface RouterTestState {
	reactHydrate: Mock<(target: Element, node: unknown) => void>;
	reactRender: Mock<() => void>;
	reactUnmount: Mock<() => void>;
	resolveComponent: Mock<ResolveComponent>;
}

async function bootHydratedReactPage(
	initialUrl = "/start",
	page: Record<string, unknown> = {},
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
			...page,
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
	if (opts.dataPhoton) a.dataset.photon = opts.dataPhoton;
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
	delete document.documentElement.dataset.photonRouterInstalled;
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
				// Reads go to the REAL Location, with `target` as the receiver.
				// `origin`, `pathname` and the rest are branded getters that refuse
				// a proxy receiver — CI threw `'get origin' called on an object
				// that is not a valid instance of Location` while the router read
				// the origin, so it never reached the fallback these tests assert
				// on. Node's own DOM happened to tolerate it, which is why this
				// only ever failed there.
				get(target, prop) {
					const value = Reflect.get(target, prop, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
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
		await waitFor(
			() => hrefSetter.mock.calls.length > 0,
			"the fallback reload for /missing",
		);

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
				// Reads go to the REAL Location, with `target` as the receiver.
				// `origin`, `pathname` and the rest are branded getters that refuse
				// a proxy receiver — CI threw `'get origin' called on an object
				// that is not a valid instance of Location` while the router read
				// the origin, so it never reached the fallback these tests assert
				// on. Node's own DOM happened to tolerate it, which is why this
				// only ever failed there.
				get(target, prop) {
					const value = Reflect.get(target, prop, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
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
		await waitFor(
			() => hrefSetter.mock.calls.length > 0,
			"the fallback reload for /html-page",
		);

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
				// Reads go to the REAL Location, with `target` as the receiver.
				// `origin`, `pathname` and the rest are branded getters that refuse
				// a proxy receiver — CI threw `'get origin' called on an object
				// that is not a valid instance of Location` while the router read
				// the origin, so it never reached the fallback these tests assert
				// on. Node's own DOM happened to tolerate it, which is why this
				// only ever failed there.
				get(target, prop) {
					const value = Reflect.get(target, prop, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
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
		await waitFor(
			() => hrefSetter.mock.calls.length > 0,
			"the fallback reload for /bad",
		);

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
				// Reads go to the REAL Location, with `target` as the receiver.
				// `origin`, `pathname` and the rest are branded getters that refuse
				// a proxy receiver — CI threw `'get origin' called on an object
				// that is not a valid instance of Location` while the router read
				// the origin, so it never reached the fallback these tests assert
				// on. Node's own DOM happened to tolerate it, which is why this
				// only ever failed there.
				get(target, prop) {
					const value = Reflect.get(target, prop, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
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
				// Reads go to the REAL Location, with `target` as the receiver.
				// `origin`, `pathname` and the rest are branded getters that refuse
				// a proxy receiver — CI threw `'get origin' called on an object
				// that is not a valid instance of Location` while the router read
				// the origin, so it never reached the fallback these tests assert
				// on. Node's own DOM happened to tolerate it, which is why this
				// only ever failed there.
				get(target, prop) {
					const value = Reflect.get(target, prop, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
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

/** Record what the router assigns to `location.href`, reads still going through. */
function spyOnHrefSetter(): {
	hrefSetter: Mock<(value: unknown) => void>;
	restore: () => void;
} {
	const hrefSetter = vi.fn<(value: unknown) => void>();
	const originalLocation = window.location;
	Object.defineProperty(window, "location", {
		configurable: true,
		value: new Proxy(originalLocation, {
			get(target, prop) {
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
			set(target, prop, value) {
				if (prop === "href") {
					hrefSetter(value);
					return true;
				}
				Reflect.set(target, prop, value);
				return true;
			},
		}),
	});
	return {
		hrefSetter,
		restore: () =>
			Object.defineProperty(window, "location", {
				configurable: true,
				value: originalLocation,
			}),
	};
}

function sentHeader(
	init: RequestInit | undefined,
	name: string,
): string | undefined {
	const headers = init?.headers;
	if (
		headers === undefined ||
		headers instanceof Headers ||
		Array.isArray(headers)
	) {
		return undefined;
	}
	return headers[name];
}

describe("photon/client > router — asset versioning", () => {
	it("echoes the version it was served, then the one each page brings", async () => {
		await bootHydratedReactPage("/start", { version: "v1" });
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						component: "Orders",
						props: {},
						url: "/orders",
						framework: "react",
						version: "v2",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		dispatchClick(createAnchor({ href: "/orders" }));
		await waitFor(() => fetchMock.mock.calls.length === 1, "first fetch");
		expect(sentHeader(fetchMock.mock.calls[0]?.[1], "x-photon-version")).toBe(
			"v1",
		);

		await new Promise((r) => setTimeout(r, 0));
		dispatchClick(createAnchor({ href: "/orders?page=2" }));
		await waitFor(() => fetchMock.mock.calls.length === 2, "second fetch");
		expect(sentHeader(fetchMock.mock.calls[1]?.[1], "x-photon-version")).toBe(
			"v2",
		);
	});

	it("follows a 409 to the location the server names", async () => {
		await bootHydratedReactPage("/start", { version: "v1" });
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("", {
						status: 409,
						headers: { "x-photon-location": "https://sso.example/login" },
					}),
			),
		);
		const { hrefSetter, restore } = spyOnHrefSetter();
		try {
			dispatchClick(createAnchor({ href: "/account" }));
			await waitFor(() => hrefSetter.mock.calls.length > 0, "the 409 reload");
			expect(hrefSetter).toHaveBeenCalledWith("https://sso.example/login");
		} finally {
			restore();
		}
	});

	it("never follows a 409 to a script URL", async () => {
		await bootHydratedReactPage();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("", {
						status: 409,
						headers: { "x-photon-location": "javascript:alert(1)" },
					}),
			),
		);
		const { hrefSetter, restore } = spyOnHrefSetter();
		try {
			dispatchClick(createAnchor({ href: "/account" }));
			await waitFor(() => hrefSetter.mock.calls.length > 0, "the 409 reload");
			expect(hrefSetter).toHaveBeenCalledWith("/account");
		} finally {
			restore();
		}
	});
});

/** Count `location.reload()` calls, everything else going to the real Location. */
function spyOnReload(): { reload: Mock<() => void>; restore: () => void } {
	const reload = vi.fn<() => void>();
	const originalLocation = window.location;
	Object.defineProperty(window, "location", {
		configurable: true,
		// An empty target: `reload` is a non-configurable own property of the
		// real Location, and a proxy over it may not report another value.
		value: new Proxy(
			{},
			{
				get(_target, prop) {
					if (prop === "reload") return reload;
					const value = Reflect.get(originalLocation, prop, originalLocation);
					return typeof value === "function"
						? value.bind(originalLocation)
						: value;
				},
			},
		),
	});
	return {
		reload,
		restore: () =>
			Object.defineProperty(window, "location", {
				configurable: true,
				value: originalLocation,
			}),
	};
}

describe("photon/client > router — encrypted history", () => {
	afterEach(() => {
		sessionStorage.clear();
	});

	it("pushes a page that asks for encryption as ciphertext", async () => {
		await bootHydratedReactPage();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							component: "Account",
							props: { iban: "CH93 0076" },
							url: "/account",
							framework: "react",
							encryptHistory: true,
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		);
		const pushState = vi.spyOn(history, "pushState");
		dispatchClick(createAnchor({ href: "/account" }));
		await waitFor(() => pushState.mock.calls.length > 0, "the pushState");
		const state: unknown = pushState.mock.calls[0]?.[0];
		expect(
			typeof state === "object" && state !== null && "photonEncrypted" in state,
		).toBe(true);
		expect(JSON.stringify(state)).not.toContain("CH93");
	});

	it("renders an encrypted entry again while its key is there", async () => {
		const state = await bootHydratedReactPage("/account", {
			props: { iban: "CH93 0076" },
			encryptHistory: true,
		});
		const sealed: unknown = history.state;
		window.dispatchEvent(new PopStateEvent("popstate", { state: sealed }));
		await waitFor(
			() => state.reactRender.mock.calls.length > 0,
			"the render from history",
		);
		expect(JSON.stringify(state.reactRender.mock.calls[0])).toContain("CH93");
	});

	it("reloads from the server when the back button meets a cleared entry", async () => {
		const state = await bootHydratedReactPage("/account", {
			props: { iban: "CH93 0076" },
			encryptHistory: true,
		});
		const sealed: unknown = history.state;
		expect(JSON.stringify(sealed)).not.toContain("CH93");
		// Logout: a page carrying clearHistory drops the key.
		sessionStorage.clear();

		const { reload, restore } = spyOnReload();
		try {
			window.dispatchEvent(new PopStateEvent("popstate", { state: sealed }));
			await waitFor(() => reload.mock.calls.length > 0, "the reload");
			expect(state.reactRender).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	it("reloads a page the back-forward cache restores once its entry is unreadable", async () => {
		await bootHydratedReactPage("/account", { encryptHistory: true });
		sessionStorage.clear();
		const { reload, restore } = spyOnReload();
		try {
			window.dispatchEvent(
				new PageTransitionEvent("pageshow", { persisted: true }),
			);
			await waitFor(() => reload.mock.calls.length > 0, "the reload");
		} finally {
			restore();
		}
	});

	it("drops the key when the first page loaded carries clearHistory", async () => {
		sessionStorage.setItem("photon:history-key", JSON.stringify([1, 2, 3]));
		await bootHydratedReactPage("/login", { clearHistory: true });
		expect(sessionStorage.getItem("photon:history-key")).toBeNull();
	});
});

/** A JSON page response, as the server sends a partial reload. */
function pageResponse(page: Record<string, unknown>): Response {
	return new Response(JSON.stringify({ framework: "react", ...page }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("photon/client > router — deferred props", () => {
	it("asks for each group once the page is up, and merges what comes back", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const only = sentHeader(init, "x-photon-partial-data");
			if (only === "stats,chart") {
				return pageResponse({
					component: "Home",
					url: "/start",
					props: { stats: 42, chart: [1, 2], errors: { wiped: "no" } },
				});
			}
			return pageResponse({
				component: "Home",
				url: "/start",
				props: { logs: ["boot"] },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const state = await bootHydratedReactPage("/start", {
			props: { x: 1, errors: { email: "required" } },
			deferredProps: { panels: ["stats", "chart"], audit: ["logs"] },
		});
		await waitFor(
			() => state.reactRender.mock.calls.length === 2,
			"both deferred groups rendered",
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const [url, init] of fetchMock.mock.calls) {
			expect(url).toBe("/start");
			expect(sentHeader(init, "x-photon")).toBe("true");
			expect(sentHeader(init, "x-photon-partial-component")).toBe("Home");
		}
		const last = JSON.stringify(state.reactRender.mock.calls.at(-1));
		expect(last).toContain('"stats":42');
		expect(last).toContain('"logs":["boot"]');
		expect(last).toContain('"x":1');
		// The form's errors are the page's, not the background request's.
		expect(last).toContain('"email":"required"');
		expect(last).not.toContain("wiped");
	});

	it("does not ask again for a group the page already holds", async () => {
		const fetchMock = vi.fn(async () =>
			pageResponse({ component: "Home", url: "/start", props: {} }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await bootHydratedReactPage("/start", {
			props: { stats: 1 },
			deferredProps: { panels: ["stats"] },
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("drops a group that arrives after the user has moved on", async () => {
		let release: (() => void) | undefined;
		const deferred = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (sentHeader(init, "x-photon-partial-data") !== undefined) {
				await deferred;
				return pageResponse({
					component: "Home",
					url: "/start",
					props: { stats: 42 },
				});
			}
			return pageResponse({ component: "Orders", url, props: {} });
		});
		vi.stubGlobal("fetch", fetchMock);

		const state = await bootHydratedReactPage("/start", {
			deferredProps: { panels: ["stats"] },
		});
		dispatchClick(createAnchor({ href: "/orders" }));
		await waitFor(
			() => state.reactRender.mock.calls.length === 1,
			"the navigation",
		);
		release?.();
		await new Promise((r) => setTimeout(r, 10));

		expect(state.reactRender).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(state.reactRender.mock.calls[0])).not.toContain(
			"stats",
		);
	});

	it("lets the other groups arrive when one fails", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) =>
				sentHeader(init, "x-photon-partial-data") === "broken"
					? new Response("", { status: 500 })
					: pageResponse({
							component: "Home",
							url: "/start",
							props: { fine: true },
						}),
			),
		);
		const state = await bootHydratedReactPage("/start", {
			deferredProps: { a: ["broken"], b: ["fine"] },
		});
		await waitFor(
			() => state.reactRender.mock.calls.length === 1,
			"the healthy group",
		);
		expect(JSON.stringify(state.reactRender.mock.calls[0])).toContain(
			'"fine":true',
		);
		expect(errSpy).toHaveBeenCalled();
	});
});

describe("photon/client > router — visit and reload", () => {
	it("reload({ only }) asks for those props and merges them in place", async () => {
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
			pageResponse({
				component: "Home",
				url: "/start",
				props: { stats: 2, errors: { email: "taken" } },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const state = await bootHydratedReactPage("/start", {
			props: { x: 1, stats: 1, errors: {} },
		});
		const pushState = vi.spyOn(history, "pushState");
		const replaceState = vi.spyOn(history, "replaceState");

		await router.reload({ only: ["stats"] });

		const init = fetchMock.mock.calls[0]?.[1];
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/start");
		expect(sentHeader(init, "x-photon-partial-component")).toBe("Home");
		expect(sentHeader(init, "x-photon-partial-data")).toBe("stats");
		expect(sentHeader(init, "cache-control")).toBe("no-cache");
		const rendered = JSON.stringify(state.reactRender.mock.calls.at(-1));
		expect(rendered).toContain('"stats":2');
		expect(rendered).toContain('"x":1');
		// An explicit reload takes the server's errors, unlike a deferred group.
		expect(rendered).toContain('"email":"taken"');
		expect(pushState).not.toHaveBeenCalled();
		expect(replaceState).toHaveBeenCalled();
	});

	it("reload({ reset }) asks for the prop and says to replace it", async () => {
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
			pageResponse({ component: "Home", url: "/start", props: { rows: [] } }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await bootHydratedReactPage("/start", { props: { rows: [1, 2] } });

		await router.reload({ only: ["stats"], reset: ["rows"] });

		const init = fetchMock.mock.calls[0]?.[1];
		expect(sentHeader(init, "x-photon-partial-data")).toBe("stats,rows");
		expect(sentHeader(init, "x-photon-reset")).toBe("rows");
	});

	it("reload() without props reloads the whole page in place", async () => {
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
			pageResponse({ component: "Home", url: "/start", props: { x: 2 } }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const state = await bootHydratedReactPage("/start");
		const pushState = vi.spyOn(history, "pushState");

		await router.reload();

		expect(
			sentHeader(fetchMock.mock.calls[0]?.[1], "x-photon-partial-component"),
		).toBeUndefined();
		expect(JSON.stringify(state.reactRender.mock.calls.at(-1))).toContain(
			'"x":2',
		);
		expect(pushState).not.toHaveBeenCalled();
	});

	it("visit() navigates like a link, and replace swaps the history entry", async () => {
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
			pageResponse({ component: "Orders", url, props: {} }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await bootHydratedReactPage("/start");
		const pushState = vi.spyOn(history, "pushState");
		const replaceState = vi.spyOn(history, "replaceState");

		await router.visit("/orders");
		expect(pushState).toHaveBeenCalledTimes(1);

		await router.visit("/orders?page=2", { replace: true, errorBag: "login" });
		expect(pushState).toHaveBeenCalledTimes(1);
		expect(replaceState.mock.calls.at(-1)?.[2]).toBe("/orders?page=2");
		expect(sentHeader(fetchMock.mock.calls[1]?.[1], "x-photon-error-bag")).toBe(
			"login",
		);
	});

	it("visit() to another origin is a full navigation", async () => {
		vi.stubGlobal("fetch", vi.fn());
		await bootHydratedReactPage();
		const { hrefSetter, restore } = spyOnHrefSetter();
		try {
			await router.visit("https://elsewhere.example/x");
			expect(hrefSetter).toHaveBeenCalledWith("https://elsewhere.example/x");
		} finally {
			restore();
		}
	});
});

describe("photon/client > router — merged props", () => {
	it("appends the next slice of a merge prop instead of replacing the list", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				pageResponse({
					component: "Home",
					url: "/start",
					props: { rows: [{ id: 2 }, { id: 3 }] },
					mergeProps: ["rows"],
					matchPropsOn: ["rows.id"],
				}),
			),
		);
		const state = await bootHydratedReactPage("/start", {
			props: { rows: [{ id: 1 }, { id: 2 }] },
		});

		await router.reload({ only: ["rows"] });

		expect(JSON.stringify(state.reactRender.mock.calls.at(-1))).toContain(
			'"rows":[{"id":1},{"id":2},{"id":3}]',
		);
	});

	it("replaces a merge prop on a full visit", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				pageResponse({
					component: "Home",
					url: "/start",
					props: { rows: [{ id: 9 }] },
					mergeProps: ["rows"],
				}),
			),
		);
		const state = await bootHydratedReactPage("/start", {
			props: { rows: [{ id: 1 }] },
		});

		await router.reload();

		expect(JSON.stringify(state.reactRender.mock.calls.at(-1))).toContain(
			'"rows":[{"id":9}]',
		);
	});
});

describe("photon/client > router — once props", () => {
	it("tells the server what it holds, and keeps it when the server skips it", async () => {
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
			pageResponse({
				component: "Signup",
				url,
				props: { step: 2 },
				onceProps: { countries: { prop: "countries", expiresAt: null } },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const state = await bootHydratedReactPage("/start", {
			props: { countries: ["CH", "FR"] },
			onceProps: { countries: { prop: "countries", expiresAt: null } },
		});

		await router.visit("/signup");

		expect(
			sentHeader(fetchMock.mock.calls[0]?.[1], "x-photon-except-once-props"),
		).toBe("countries");
		const rendered = JSON.stringify(state.reactRender.mock.calls.at(-1));
		expect(rendered).toContain('"countries":["CH","FR"]');
		expect(rendered).toContain('"step":2');
	});
});

describe("photon/client > router — flash", () => {
	function listen(): Array<unknown> {
		const seen: unknown[] = [];
		document.addEventListener("photon:flash", (event) => {
			if (event instanceof CustomEvent) seen.push(event.detail);
		});
		return seen;
	}

	it("announces the first page's flash once it is up", async () => {
		const seen = listen();
		vi.stubGlobal("fetch", vi.fn());
		await bootHydratedReactPage("/start", { flash: { success: "Saved" } });
		await waitFor(() => seen.length > 0, "the flash event");
		expect(seen).toEqual([{ flash: { success: "Saved" } }]);
	});

	it("announces a visit's flash, and never stores it in history", async () => {
		const seen = listen();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				pageResponse({
					component: "Orders",
					url,
					props: {},
					flash: { success: "Created" },
				}),
			),
		);
		await bootHydratedReactPage();
		const pushState = vi.spyOn(history, "pushState");

		await router.visit("/orders");

		expect(seen).toEqual([{ flash: { success: "Created" } }]);
		expect(JSON.stringify(pushState.mock.calls[0]?.[0])).not.toContain(
			"Created",
		);
	});

	it("stays quiet for a deferred group and an empty bag", async () => {
		const seen = listen();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				pageResponse({
					component: "Home",
					url: "/start",
					props: { stats: 1 },
					flash: { success: "again" },
				}),
			),
		);
		const state = await bootHydratedReactPage("/start", {
			flash: {},
			deferredProps: { panels: ["stats"] },
		});
		await waitFor(
			() => state.reactRender.mock.calls.length > 0,
			"the deferred group",
		);
		await new Promise((r) => setTimeout(r, 0));
		expect(seen).toEqual([]);
	});
});

describe("photon/client > infinite scroll data", () => {
	const cursor = (
		currentPage: number,
		nextPage: number | null,
		previousPage: number | null,
		reset = false,
	) => ({ pageName: "page", currentPage, nextPage, previousPage, reset });

	it("loads the next page into the list and stops at the last one", async () => {
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
			pageResponse({
				component: "Users",
				url: "/users?page=3",
				props: { users: { data: [5, 6] } },
				mergeProps: ["users.data"],
				scrollProps: { users: cursor(3, null, 2) },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const state = await bootHydratedReactPage("/users", {
			component: "Users",
			props: { users: { data: [3, 4] } },
			scrollProps: { users: cursor(2, 3, 1) },
		});
		const replaceState = vi.spyOn(history, "replaceState");
		const scroll = useInfiniteScrollData({ getPropName: () => "users" });
		expect(scroll.hasNext()).toBe(true);
		expect(scroll.hasPrevious()).toBe(true);

		await scroll.fetchNext();

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("/users?page=3");
		expect(sentHeader(init, "x-photon-partial-data")).toBe("users");
		expect(sentHeader(init, "x-photon-infinite-scroll-merge-intent")).toBe(
			"append",
		);
		expect(JSON.stringify(state.reactRender.mock.calls.at(-1))).toContain(
			'"data":[3,4,5,6]',
		);
		// The address bar stays where the user is.
		expect(replaceState.mock.calls.at(-1)?.[2]).toBe("/users");
		expect(scroll.getLastLoadedPage()).toBe(3);
		expect(scroll.getRequestCount()).toBe(1);
		expect(scroll.hasNext()).toBe(false);
		expect(scroll.hasPrevious()).toBe(true);

		await scroll.fetchNext();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("puts the previous page before the rows shown", async () => {
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
			pageResponse({
				component: "Users",
				url: "/users?page=1",
				props: { users: { data: [1, 2] } },
				prependProps: ["users.data"],
				scrollProps: { users: cursor(1, 2, null) },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const state = await bootHydratedReactPage("/users?page=2", {
			component: "Users",
			props: { users: { data: [3, 4] } },
			scrollProps: { users: cursor(2, 3, 1) },
		});
		const scroll = useInfiniteScrollData({ getPropName: () => "users" });

		await scroll.fetchPrevious();

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("/users?page=1");
		expect(sentHeader(init, "x-photon-infinite-scroll-merge-intent")).toBe(
			"prepend",
		);
		expect(JSON.stringify(state.reactRender.mock.calls.at(-1))).toContain(
			'"data":[1,2,3,4]',
		);
		expect(scroll.hasPrevious()).toBe(false);
		expect(scroll.hasNext()).toBe(true);
	});

	it("asks once while a page is loading", async () => {
		const fetchMock = vi.fn(async () =>
			pageResponse({
				component: "Users",
				url: "/users",
				props: { users: { data: [] } },
				scrollProps: { users: cursor(2, null, 1) },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		await bootHydratedReactPage("/users", {
			component: "Users",
			props: { users: { data: [] } },
			scrollProps: { users: cursor(1, 2, null) },
		});
		const scroll = useInfiniteScrollData({ getPropName: () => "users" });
		await Promise.all([scroll.fetchNext(), scroll.fetchNext()]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("starts over when the server says the list was reset", async () => {
		const fetchMock = vi.fn(async () =>
			pageResponse({
				component: "Users",
				url: "/users",
				props: { users: { data: [9] } },
				scrollProps: { users: cursor(1, 2, null, true) },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		await bootHydratedReactPage("/users", {
			component: "Users",
			props: { users: { data: [1] } },
			scrollProps: { users: cursor(5, null, 4) },
		});
		const onReset = vi.fn();
		const scroll = useInfiniteScrollData({
			getPropName: () => "users",
			onReset,
		});
		expect(scroll.hasNext()).toBe(false);

		await router.reload({ reset: ["users"] });

		expect(scroll.hasNext()).toBe(true);
		expect(scroll.getLastLoadedPage()).toBe(1);
		expect(onReset).toHaveBeenCalledTimes(1);
	});

	it("says which scroll prop is missing", async () => {
		vi.stubGlobal("fetch", vi.fn());
		await bootHydratedReactPage();
		expect(() => useInfiniteScrollData({ getPropName: () => "users" })).toThrow(
			/scroll prop named "users"/,
		);
	});
});

describe("photon/client > router — events, callbacks, remember", () => {
	it("announces every visit that reached the screen, until unsubscribed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				pageResponse({ component: "Orders", url, props: {} }),
			),
		);
		await bootHydratedReactPage();
		const seen: string[] = [];
		const off = router.on("success", (event) => {
			seen.push(event.detail.page.url);
		});
		await router.visit("/orders");
		off();
		await router.visit("/orders?page=2");
		expect(seen).toEqual(["/orders"]);
	});

	it("runs the visit callbacks, and onBefore can cancel", async () => {
		const fetchMock = vi.fn(async (url: string) =>
			pageResponse({ component: "Orders", url, props: {} }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await bootHydratedReactPage();
		const calls: string[] = [];

		await router.visit("/orders", { onBefore: () => false });
		expect(fetchMock).not.toHaveBeenCalled();

		await router.visit("/orders", {
			onBefore: () => {
				calls.push("before");
				return undefined;
			},
			onBeforeUpdate: () => calls.push("beforeUpdate"),
			onSuccess: (page) => calls.push(`success ${page.url}`),
			onFinish: ({ completed }) => calls.push(`finish ${completed}`),
		});
		expect(calls).toEqual([
			"before",
			"beforeUpdate",
			"success /orders",
			"finish true",
		]);
	});

	it("reports an unfinished partial reload to onFinish", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 500 })),
		);
		await bootHydratedReactPage();
		const onFinish = vi.fn();
		await router.reload({ only: ["x"], onFinish });
		expect(onFinish).toHaveBeenCalledWith({ url: "/start", completed: false });
	});

	it("remembers state in the history entry, and keeps it across a reload of the tab", async () => {
		vi.stubGlobal("fetch", vi.fn());
		await bootHydratedReactPage("/start");
		router.remember({ tab: "billing" }, "settings");
		expect(router.restore("settings")).toEqual({ tab: "billing" });
		await waitFor(
			() => JSON.stringify(history.state).includes("billing"),
			"the history entry",
		);

		// The tab reloads: the same page is served again, and hydrates over the
		// entry the previous load left behind.
		const entry: unknown = history.state;
		document.documentElement.innerHTML = "";
		history.replaceState(entry, "", "/start");
		await bootHydratedReactPage("/start");
		expect(router.restore("settings")).toEqual({ tab: "billing" });
	});

	it("does not carry remembered state to another page", async () => {
		vi.stubGlobal("fetch", vi.fn());
		await bootHydratedReactPage("/start");
		router.remember(1, "k");
		await waitFor(
			() => JSON.stringify(history.state).includes("rememberedState"),
			"the history entry",
		);
		await bootHydratedReactPage("/elsewhere");
		expect(router.restore("k")).toBeUndefined();
	});

	it("replace() moves the address without a request, same origin only", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await bootHydratedReactPage("/users");
		const replaceState = vi.spyOn(history, "replaceState");

		router.replace({ url: "/users?page=3" });
		await waitFor(() => replaceState.mock.calls.length > 0, "the replace");
		expect(replaceState.mock.calls.at(-1)?.[2]).toBe("/users?page=3");

		router.replace({ url: "https://elsewhere.example/x" });
		await new Promise((r) => setTimeout(r, 0));
		expect(replaceState).toHaveBeenCalledTimes(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("photon/client > router — visits other than GET", () => {
	it("posts JSON with the XSRF token the server seeded", async () => {
		// The cookie as the server's CSRF middleware seeds it, URL-encoded.
		vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
			"theme=dark; XSRF-TOKEN=abc%3Ddef",
		);
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
			pageResponse({ component: "Orders", url: "/orders/1", props: {} }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await bootHydratedReactPage();
		const onSuccess = vi.fn();

		await router.post("/orders", { item: "tea", qty: 2 }, { onSuccess });

		const init = fetchMock.mock.calls[0]?.[1];
		expect(init?.method).toBe("POST");
		expect(init?.body).toBe('{"item":"tea","qty":2}');
		expect(sentHeader(init, "content-type")).toBe("application/json");
		expect(sentHeader(init, "X-XSRF-TOKEN")).toBe("abc=def");
		expect(onSuccess).toHaveBeenCalledTimes(1);
	});

	it("sends multipart as soon as there is a file, nested keys bracketed", async () => {
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
			pageResponse({ component: "Profile", url: "/profile", props: {} }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await bootHydratedReactPage();

		await router.put("/profile", {
			avatar: new File(["x"], "me.png"),
			user: { name: "Ada", admin: false },
			tags: ["a", "b"],
		});

		const body = fetchMock.mock.calls[0]?.[1]?.body;
		if (!(body instanceof FormData)) throw new Error("expected FormData");
		expect(body.get("avatar")).toBeInstanceOf(File);
		expect(body.get("user[name]")).toBe("Ada");
		expect(body.get("user[admin]")).toBe("0");
		expect(body.getAll("tags[]")).toEqual(["a", "b"]);
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
	});

	it("calls onError, not onSuccess, when the page comes back with errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				pageResponse({
					component: "Login",
					url: "/login",
					props: { errors: { login: { email: "required" } } },
				}),
			),
		);
		await bootHydratedReactPage();
		const onSuccess = vi.fn();
		const onError = vi.fn();
		const heard: unknown[] = [];
		const off = router.on("error", (event) => heard.push(event.detail.errors));

		await router.post("/login", {}, { errorBag: "login", onSuccess, onError });
		off();

		expect(onError).toHaveBeenCalledWith({ email: "required" });
		expect(onSuccess).not.toHaveBeenCalled();
		expect(heard).toEqual([{ email: "required" }]);
	});

	it("stays on the page when a mutation fails, instead of reloading its URL as a GET", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 500 })),
		);
		await bootHydratedReactPage();
		const { hrefSetter, restore } = spyOnHrefSetter();
		try {
			await router.delete("/orders/1");
			expect(hrefSetter).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	it("puts a GET visit's data in the query, nested and repeated", async () => {
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
			pageResponse({ component: "Search", url, props: {} }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await bootHydratedReactPage();

		await router.get("/search?page=1", {
			q: "tea",
			filter: { tag: ["a", "b"] },
		});

		const url = new URL(
			String(fetchMock.mock.calls[0]?.[0]),
			"http://localhost/",
		);
		expect(url.searchParams.get("q")).toBe("tea");
		expect(url.searchParams.get("page")).toBe("1");
		expect(url.searchParams.getAll("filter[tag][]")).toEqual(["a", "b"]);
		expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
	});
});
