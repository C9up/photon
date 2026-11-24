/**
 * @vitest-environment jsdom
 *
 * The router keeps every request on the application's origin.
 *
 * `/.//evil.example/x` and `https://app.example//evil.example/x` are on the
 * application's origin: their path is `//evil.example/x`. Cut down to that
 * path and handed back to `fetch()` or `location.href`, the string is read as
 * another host. The router requests and navigates to the absolute URL it
 * checked, and checks the URL again right before every request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	bootPage,
	type PhotonAdapterHandle,
	type PhotonHost,
	router,
} from "../../../src/client/hydrate.js";
import { pathOf, withQuery } from "../../../src/client/router.js";

const ORIGIN = "https://app.example";
const EVIL = "https://evil.example";

interface Seen {
	url: string;
	origin: string;
	method: string;
	headers: Record<string, string>;
}

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
	});
}

/** The router's click handler, wired once by the first host it starts on. */
let clickHandler: ((event: unknown) => void) | undefined;

/**
 * A host that resolves a request URL the way a browser's `fetch` does, and
 * answers on the application's origin with a page at the path asked for, its
 * `url` written as the server writes it.
 */
function browserLikeHost(
	answer: (url: URL, init: RequestInit) => Response = (url) =>
		json({
			component: "Home",
			props: { at: url.pathname },
			url: pathOf(url),
			framework: "react",
		}),
) {
	let href = `${ORIGIN}/`;
	const seen: Seen[] = [];
	const loads: string[] = [];
	const host: PhotonHost = {
		href: () => href,
		baseUri: () => href,
		fetch: async (url, init) => {
			const resolved = new URL(url, href);
			const headers: Record<string, string> = {};
			new Headers(init.headers).forEach((value, key) => {
				headers[key] = value;
			});
			seen.push({
				url,
				origin: resolved.origin,
				method: String(init.method ?? "GET"),
				headers,
			});
			if (resolved.origin !== ORIGIN) {
				return json({
					component: "Home",
					props: { at: "evil" },
					url: "/",
					framework: "react",
				});
			}
			return answer(resolved, init);
		},
		state: () => null,
		push: (_state, url) => {
			href = new URL(url, href).href;
		},
		replace: (_state, url) => {
			href = new URL(url, href).href;
		},
		load: (url) => loads.push(new URL(url, href).href),
		reload: () => {},
		emit: () => {},
		cookie: (name) => (name === "XSRF-TOKEN" ? "csrf-token" : undefined),
		memoryHistory: true,
		listen: (wired) => {
			clickHandler = wired.click;
		},
	};
	return { host, seen, loads, href: () => href };
}

const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};

async function boot(
	world: ReturnType<typeof browserLikeHost>,
	first: Record<string, unknown> = {
		component: "Home",
		props: {},
		url: "/",
		framework: "react",
	},
) {
	const updates: Array<Record<string, unknown>> = [];
	const handle: PhotonAdapterHandle = {
		update: (_component, props) => updates.push(props),
		unmount: () => {},
	};
	const firstFetch = world.host.fetch;
	let firstServed = false;
	world.host.fetch = (url, init) => {
		if (firstServed) return firstFetch(url, init);
		firstServed = true;
		return Promise.resolve(json(first));
	};
	await bootPage({
		host: world.host,
		url: "/",
		resolveComponent: async (name) => ({ default: name }),
		mount: async () => handle,
	});
	world.host.fetch = firstFetch;
	return updates;
}

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("photon/client > router keeps requests on the origin", () => {
	it("requests a `/.//host` path on the application's origin", async () => {
		const world = browserLikeHost();
		const updates = await boot(world);

		await router.visit("/.//evil.example/x");
		await settle();

		const request = world.seen.at(-1);
		expect(request?.url).toBe(`${ORIGIN}//evil.example/x`);
		expect(request?.origin).toBe(ORIGIN);
		expect(updates.at(-1)).toEqual({ at: "//evil.example/x" });
		expect(world.href()).toBe(`${ORIGIN}//evil.example/x`);
		expect(world.loads).toEqual([]);
	});

	it("keeps the absolute form on the origin, its fallback too", async () => {
		const world = browserLikeHost(() => new Response("", { status: 500 }));
		await boot(world);

		await router.visit(`${ORIGIN}//evil.example/x?a=1#top`);
		await settle();

		const request = world.seen.at(-1);
		// The fragment is no part of the request; the fallback keeps it.
		expect(request?.url).toBe(`${ORIGIN}//evil.example/x?a=1`);
		expect(request?.origin).toBe(ORIGIN);
		expect(world.loads).toEqual([`${ORIGIN}//evil.example/x?a=1#top`]);
	});

	it("sends a mutation's body, and its CSRF token, to the origin", async () => {
		const world = browserLikeHost(() => new Response("", { status: 204 }));
		await boot(world);

		await router.post("/.//evil.example/collect", { email: "a@b.example" });
		await settle();

		const request = world.seen.at(-1);
		expect(request?.method).toBe("POST");
		expect(request?.origin).toBe(ORIGIN);
		expect(request?.headers["x-xsrf-token"]).toBe("csrf-token");
	});

	it("merges a GET visit's data without turning the path into a host", async () => {
		const world = browserLikeHost();
		await boot(world);

		await router.get("/.//evil.example/x", { q: "tea" });
		await settle();

		expect(world.seen.at(-1)?.url).toBe(`${ORIGIN}//evil.example/x?q=tea`);
	});

	it("follows a clicked `a[data-photon]` to the origin", async () => {
		const world = browserLikeHost();
		await boot(world);
		const anchor = document.createElement("a");
		anchor.setAttribute("href", "/.//evil.example/x");
		anchor.dataset.photon = "";
		document.body.append(anchor);
		anchor.addEventListener("click", (event) => clickHandler?.(event));

		anchor.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
		);
		await settle();

		expect(world.seen.at(-1)?.origin).toBe(ORIGIN);
		expect(world.seen.at(-1)?.url).toBe(`${ORIGIN}//evil.example/x`);
		anchor.remove();
	});

	it("asks for a first page's deferred props on the origin, whatever its url says", async () => {
		const world = browserLikeHost((url) =>
			json({
				component: "NotFound",
				props: { suggestions: ["a"] },
				url: pathOf(url),
				framework: "react",
			}),
		);
		const updates = await boot(world, {
			component: "NotFound",
			props: {},
			url: "//evil.example/x",
			framework: "react",
			deferredProps: { default: ["suggestions"] },
		});
		await settle();

		const partial = world.seen.at(-1);
		expect(partial?.origin).toBe(ORIGIN);
		expect(partial?.headers["x-photon-partial-data"]).toBe("suggestions");
		expect(updates.at(-1)).toEqual({ suggestions: ["a"] });
		expect(world.seen.every((request) => request.origin === ORIGIN)).toBe(true);
	});

	it("reloads the page on screen from the origin", async () => {
		const world = browserLikeHost();
		await boot(world, {
			component: "Home",
			props: {},
			url: "//evil.example/x",
			framework: "react",
		});

		await router.reload();
		await settle();

		expect(world.seen.at(-1)?.origin).toBe(ORIGIN);
	});

	it("leaves for another origin only as a full load, never as a request", async () => {
		const world = browserLikeHost();
		await boot(world);
		const before = world.seen.length;

		await router.visit(`${EVIL}/x`);
		await router.visit("//evil.example/x");
		await settle();

		expect(world.seen.length).toBe(before);
		expect(world.loads).toEqual([`${EVIL}/x`, `${EVIL}/x`]);
	});
});

describe("photon/client > withQuery", () => {
	it("keeps a path that starts with `//` a path", () => {
		const merged = withQuery("/.//evil.example/x", { q: "1" });
		expect(merged).toBe("/.//evil.example/x?q=1");
		expect(new URL(merged, `${ORIGIN}/`).origin).toBe(ORIGIN);
	});

	it("keeps a scheme-relative URL on the host it names", () => {
		expect(withQuery("//cdn.example/x", { q: "1" })).toBe(
			"//cdn.example/x?q=1",
		);
	});

	it("leaves an ordinary path as it was", () => {
		expect(withQuery("/search?page=2#top", { q: "tea" })).toBe(
			"/search?page=2&q=tea#top",
		);
	});
});
