/**
 * @vitest-environment node
 */

/**
 * The router on a host with no document — an app on a phone: its own back
 * stack, requests to a server origin, no `location` and no `history`. The
 * protocol is the browser's: same headers, same page objects, same answers
 * to a stale version.
 */
import { describe, expect, it, vi } from "vitest";
import {
	bootPage,
	type PhotonAdapterHandle,
	type PhotonHost,
	router,
} from "../../../src/client/hydrate.js";

const ORIGIN = "https://app.example";

function page(component: string, url: string, props: Record<string, unknown>) {
	return { component, props, url, framework: "orbit", version: "v1" };
}

interface Entry {
	state: unknown;
	url: string;
}

/** A back stack in memory, answering requests from a table of page objects. */
function memoryHost(answers: Record<string, () => Response>) {
	const stack: Entry[] = [{ state: null, url: `${ORIGIN}/` }];
	const requests: Array<{ url: string; headers: Record<string, string> }> = [];
	const loads: string[] = [];
	const events: string[] = [];
	let wire: Parameters<PhotonHost["listen"]>[0] | undefined;
	const top = (): Entry => {
		const entry = stack.at(-1);
		if (entry === undefined) throw new Error("empty stack");
		return entry;
	};
	const host: PhotonHost = {
		href: () => top().url,
		baseUri: () => top().url,
		fetch: async (url, init) => {
			const headers: Record<string, string> = {};
			new Headers(init.headers).forEach((value, key) => {
				headers[key] = value;
			});
			requests.push({ url, headers });
			const answer = answers[new URL(url, ORIGIN).pathname];
			return answer === undefined
				? new Response("", { status: 404 })
				: answer();
		},
		state: () => top().state,
		push: (state, url) => {
			stack.push({ state, url: new URL(url, top().url).href });
		},
		replace: (state, url) => {
			stack[stack.length - 1] = { state, url: new URL(url, top().url).href };
		},
		load: (url) => loads.push(url),
		reload: () => loads.push(top().url),
		emit: (type) => events.push(type),
		cookie: () => undefined,
		memoryHistory: true,
		listen: (router) => {
			wire = router;
		},
	};
	const back = (): void => {
		stack.pop();
		wire?.restore(top().state);
	};
	return { host, stack, requests, loads, events, back };
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json", ...headers },
	});
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("photon/client > a host with no document", () => {
	it("boots from the server, visits, goes back from its own stack, and leaves on a stale version", async () => {
		const memory = memoryHost({
			"/": () => json(page("Home", "/", { n: 1 })),
			"/orders": () => json(page("Orders", "/orders", { ids: [7] })),
			"/stale": () =>
				new Response("", {
					status: 409,
					headers: { "x-photon-location": `${ORIGIN}/stale` },
				}),
		});
		const updates: Array<[unknown, Record<string, unknown>]> = [];
		const handle: PhotonAdapterHandle = {
			update: (Component, props) => updates.push([Component, props]),
			unmount: () => {},
		};
		const mounted: unknown[] = [];
		const heard: string[] = [];
		router.on("success", (event) => heard.push(event.detail.page.component));

		await bootPage({
			host: memory.host,
			url: "/",
			resolveComponent: async (name) => ({ default: `screen:${name}` }),
			mount: async (target, Component, data) => {
				mounted.push([target, Component, data.props]);
				return handle;
			},
		});

		// The first page came from the server, asked as a visit asks.
		expect(mounted).toEqual([[undefined, "screen:Home", { n: 1 }]]);
		expect(memory.requests[0]?.headers["x-photon"]).toBe("true");

		await router.visit("/orders");
		expect(updates.at(-1)).toEqual(["screen:Orders", { ids: [7] }]);
		expect(memory.stack.map((entry) => entry.url)).toEqual([
			`${ORIGIN}/`,
			`${ORIGIN}/orders`,
		]);
		// The visit carried the version the first page had.
		expect(memory.requests.at(-1)?.headers["x-photon-version"]).toBe("v1");
		// router.on hears a visit with no document to dispatch on; the host is told too.
		expect(heard).toContain("Orders");
		expect(memory.events).toContain("success");

		// Back: the page comes from the entry the stack kept, no request.
		const asked = memory.requests.length;
		memory.back();
		await flush();
		expect(updates.at(-1)).toEqual(["screen:Home", { n: 1 }]);
		expect(memory.requests.length).toBe(asked);

		// A stale version: the host is asked for a full load, as a browser would be.
		await router.visit("/stale");
		expect(memory.loads).toEqual([`${ORIGIN}/stale`]);
	});

	it("keeps an encrypted-history page as it is: its history never leaves memory", async () => {
		const memory = memoryHost({
			"/": () =>
				json({ ...page("Home", "/", { secret: 1 }), encryptHistory: true }),
		});
		await bootPage({
			host: memory.host,
			url: "/",
			resolveComponent: async (name) => ({ default: name }),
			mount: async () => ({ update: () => {}, unmount: () => {} }),
		});
		expect(memory.stack[0]?.state).toMatchObject({
			photonData: { component: "Home", props: { secret: 1 } },
		});
	});

	it("refuses a first page that is not a page object", async () => {
		const memory = memoryHost({
			"/": () =>
				new Response("<html></html>", {
					headers: { "content-type": "text/html" },
				}),
		});
		await expect(
			bootPage({
				host: memory.host,
				url: "/",
				resolveComponent: async (name) => ({ default: name }),
				mount: async () => ({ update: () => {}, unmount: () => {} }),
			}),
		).rejects.toThrow(/not a page object/);
		await expect(
			bootPage({
				host: memory.host,
				url: "/",
				resolveComponent: async (name) => ({ default: name }),
				mount: async () => ({ update: () => {}, unmount: () => {} }),
			}),
		).rejects.toMatchObject({ code: "E_PHOTON_INVALID_PAGE_RESPONSE" });
	});

	it("refuses to request a page with no host to run on", async () => {
		vi.resetModules();
		const fresh = await import("../../../src/client/router.js");
		await expect(fresh.requestPage("/")).rejects.toMatchObject({
			code: "E_PHOTON_NO_ROUTER_HOST",
		});
	});
});
