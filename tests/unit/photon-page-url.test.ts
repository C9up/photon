/**
 * The page url keeps the query string.
 *
 * The client writes `page.url` to the address bar after every visit, and the
 * stale-version reload goes back to it: without the query, `/users?page=2`
 * turned into `/users` and the filter was gone on reload, share and back.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PhotonMiddleware,
	type PhotonMiddlewareContext,
} from "../../src/PhotonMiddleware.js";

const config = {
	framework: "react" as const,
	entryClient: "resources/app.tsx",
};

interface Written {
	status: number;
	headers: Record<string, string>;
	body?: string;
}

function harness(
	headers: Record<string, string>,
	request: Record<string, unknown>,
) {
	const written: Written = { status: 200, headers: {} };
	const response = {
		status(code: number) {
			written.status = code;
			return response;
		},
		header(name: string, value: string) {
			written.headers[name.toLowerCase()] = value;
			return response;
		},
		send(body: string) {
			written.body = body;
		},
		getHeader(name: string) {
			return written.headers[name.toLowerCase()];
		},
	};
	const ctx: Record<string, unknown> = {
		request: {
			method: () => "GET",
			header: (name: string) => headers[name.toLowerCase()],
			...request,
		},
		response,
	};
	return { ctx, written };
}

/** ream's Request: `path()` is the pathname, `url(true)` adds the query. */
const reamRequest = {
	path: () => "/users",
	url: (includeQs = false) => (includeQs ? "/users?page=2&q=bob" : "/users"),
};

async function serve(
	headers: Record<string, string>,
	request: Record<string, unknown> = reamRequest,
	render = true,
) {
	const mw = new PhotonMiddleware(config);
	const { ctx, written } = harness(headers, request);
	// The same object the middleware attaches `photon` to, read through its type.
	const typed: PhotonMiddlewareContext = ctx;
	await mw.middleware()(ctx, async () => {
		if (!render) return;
		const result = await typed.photon?.render("Users", {});
		written.body = result?.html;
	});
	return written;
}

function pageDataOf(html: string | undefined): Record<string, unknown> {
	const match = /<script[^>]*id="photon-data">([^<]*)<\/script>/.exec(
		html ?? "",
	);
	return JSON.parse(match?.[1] ?? "{}");
}

describe("photon > page url", () => {
	const orig = process.env.NODE_ENV;
	beforeEach(() => {
		process.env.NODE_ENV = "development";
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = orig;
	});

	it("keeps the query in the url of the page an HTML load hydrates from", async () => {
		const written = await serve({});
		expect(pageDataOf(written.body).url).toBe("/users?page=2&q=bob");
	});

	it("keeps the query in the url of an X-Photon payload", async () => {
		const written = await serve({ "x-photon": "true" });
		expect(JSON.parse(written.body ?? "{}").url).toBe("/users?page=2&q=bob");
	});

	it("reloads the url with its query on a stale asset version", async () => {
		const written = await serve(
			{ "x-photon": "true", "x-photon-version": "stale" },
			reamRequest,
			false,
		);
		expect(written.status).toBe(409);
		expect(written.headers["x-photon-location"]).toBe("/users?page=2&q=bob");
	});

	it("reads a Node-style url string, which already carries the query", async () => {
		const written = await serve(
			{ "x-photon": "true" },
			{ url: "/users?page=3" },
		);
		expect(JSON.parse(written.body ?? "{}").url).toBe("/users?page=3");
	});

	it("appends the raw query a duck-typed host keeps beside path()", async () => {
		const viaParsedUrl = await serve(
			{ "x-photon": "true" },
			{
				path: () => "/users",
				parsedUrl: () => ({ pathname: "/users", query: "page=2&q=bob" }),
			},
		);
		expect(JSON.parse(viaParsedUrl.body ?? "{}").url).toBe(
			"/users?page=2&q=bob",
		);

		const viaQueryString = await serve(
			{ "x-photon": "true", "x-photon-version": "stale" },
			{ path: () => "/users", query: "page=2&q=bob" },
			false,
		);
		expect(viaQueryString.headers["x-photon-location"]).toBe(
			"/users?page=2&q=bob",
		);
	});

	it("ignores a parsed query object, which carries no raw query", async () => {
		const written = await serve(
			{ "x-photon": "true" },
			{ path: () => "/users", query: { page: "2" } },
		);
		expect(JSON.parse(written.body ?? "{}").url).toBe("/users");
	});

	it("falls back to path() for a host with nothing else", async () => {
		const written = await serve({ "x-photon": "true" }, { path: () => "/p" });
		expect(JSON.parse(written.body ?? "{}").url).toBe("/p");
	});
});
