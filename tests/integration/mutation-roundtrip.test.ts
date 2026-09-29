/**
 * @vitest-environment jsdom
 *
 * A mutation end to end: the client router sends a PUT, the real
 * PhotonMiddleware answers it on Ream's real Response, the handler redirects,
 * and the page the redirect lands on reaches the client.
 *
 * `fetch` is the only stand-in — it hands the request to the middleware and
 * follows the redirect as the Fetch spec does: a 303 becomes a GET of the
 * Location, but a 301/302 only does after a POST — after a PUT the browser
 * would send the PUT again. The middleware is what turns the handler's 302
 * into a 303 for a PUT, and this test fails without it.
 */

import { Response as ReamResponse } from "@c9up/ream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootRouter, router } from "../../src/client/router.js";
import {
	PhotonMiddleware,
	type PhotonMiddlewareContext,
} from "../../src/PhotonMiddleware.js";

const orders = new Map<string, { qty: number }>([["1", { qty: 1 }]]);

/** The application: two routes, as a controller would write them. */
async function handle(
	ctx: PhotonMiddlewareContext,
	method: string,
	path: string,
	body: unknown,
	response: ReamResponse,
): Promise<void> {
	const match = /^\/orders\/(\d+)$/.exec(path);
	if (!match) {
		response.status(404).send("");
		return;
	}
	const id = match[1] ?? "";
	if (method === "PUT") {
		const qty =
			typeof body === "object" && body !== null
				? Reflect.get(body, "qty")
				: undefined;
		orders.set(id, { qty: Number(qty) });
		// What `response.redirect()` writes; the helper itself wants a full
		// HttpContext, which this test does not build.
		response.status(302).header("location", `/orders/${id}`).send("");
		return;
	}
	const out = await ctx.photon?.render("Order", { id, ...orders.get(id) });
	response.header("content-type", "text/html; charset=utf-8");
	response.send(out?.html ?? "");
}

/** One request through the middleware, as the server would run it. */
async function serve(
	method: string,
	url: URL,
	headers: Headers,
	body: unknown,
): Promise<ReamResponse> {
	const response = new ReamResponse();
	const ctx: PhotonMiddlewareContext = {
		request: {
			method: () => method,
			path: () => url.pathname,
			header: (name: string) => headers.get(name) ?? undefined,
		},
		response,
	};
	const middleware = new PhotonMiddleware({
		framework: "react",
		entryClient: "resources/app.tsx",
	}).middleware();
	await middleware(ctx, () =>
		handle(ctx, method, url.pathname, body, response),
	);
	return response;
}

/** `fetch`, following redirects the way a browser does. */
async function browserFetch(
	input: string,
	init?: RequestInit,
): Promise<Response> {
	let url = new URL(input, location.href);
	let method = (init?.method ?? "GET").toUpperCase();
	const headers = new Headers(init?.headers);
	let body: unknown =
		typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
	for (let hops = 0; hops < 5; hops++) {
		const answer = await serve(method, url, headers, body);
		const status = answer.getStatus();
		const location = answer.getHeader("location");
		if ([301, 302, 303, 307, 308].includes(status) && location) {
			statuses.push(status);
			if (
				status === 303 ||
				((status === 301 || status === 302) && method === "POST")
			) {
				method = "GET";
				body = undefined;
			}
			url = new URL(location, url);
			continue;
		}
		return new Response(answer.getBody(), {
			status,
			headers: answer.getHeaders(),
		});
	}
	throw new Error("too many redirects");
}

const seen: Array<{ method: string; path: string }> = [];
const statuses: number[] = [];

beforeEach(() => {
	process.env.NODE_ENV = "development";
	seen.length = 0;
	statuses.length = 0;
	vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
		seen.push({ method: init?.method ?? "GET", path: String(input) });
		return browserFetch(input, init);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("photon > a mutation, client to server and back", () => {
	it("PUTs, follows the server's redirect, and shows the page it lands on", async () => {
		const rendered: unknown[] = [];
		bootRouter({
			target: document.body,
			adapter: { update: (_c, props) => rendered.push(props), unmount() {} },
			resolveComponent: async () => ({ default: "Order" }),
			page: {
				component: "Order",
				framework: "react",
				url: "/orders/1",
				props: { id: "1", qty: 1 },
			},
		});

		await router.put("/orders/1", { qty: 5 });

		expect(seen).toEqual([{ method: "PUT", path: "/orders/1" }]);
		// The handler said 302; the middleware made it the 303 that a PUT needs.
		expect(statuses).toEqual([303]);
		expect(orders.get("1")).toEqual({ qty: 5 });
		expect(rendered.at(-1)).toMatchObject({ id: "1", qty: 5 });
	});
});
