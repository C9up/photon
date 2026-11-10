/**
 * `clearHistory()` survives a redirect through the session.
 *
 * The usual logout is `clearHistory()` then a redirect: the redirect carries
 * no page, so an in-request flag died with it and the client kept the key that
 * decrypts the previous user's history. With a session the instruction is
 * stored, and the next page built consumes it — once.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PhotonContext } from "../../src/PhotonContext.js";
import {
	PhotonMiddleware,
	type PhotonMiddlewareContext,
} from "../../src/PhotonMiddleware.js";

const config = {
	framework: "react" as const,
	entryClient: "resources/app.tsx",
	encryptHistory: true,
	assetsVersion: "v2",
};

/** The part of a session store the instruction needs, over one shared map. */
function fakeSession(store: Map<string, unknown>) {
	return {
		put: (key: string, value: unknown) => {
			store.set(key, value);
		},
		has: (key: string) => store.has(key),
		pull: (key: string, fallback?: unknown) => {
			const value = store.has(key) ? store.get(key) : fallback;
			store.delete(key);
			return value;
		},
	};
}

interface Written {
	status: number;
	headers: Record<string, string>;
	body?: string;
}

async function serve(
	mw: PhotonMiddleware,
	opts: {
		method?: string;
		headers?: Record<string, string>;
		store?: Map<string, unknown>;
		handler: (photon: PhotonContext) => Promise<string | undefined>;
	},
): Promise<Written> {
	const headers = opts.headers ?? {};
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
	const ctx: PhotonMiddlewareContext = {
		request: {
			method: () => opts.method ?? "GET",
			path: () => "/",
			header: (name: string) => headers[name.toLowerCase()],
		},
		response,
	};
	const host = Object.assign(
		ctx,
		opts.store ? { session: fakeSession(opts.store) } : {},
	);
	await mw.middleware()(host, async () => {
		const photon = host.photon;
		if (photon === undefined) throw new Error("ctx.photon was not attached");
		const body = await opts.handler(photon);
		if (body !== undefined) written.body = body;
	});
	return written;
}

const spa = { "x-photon": "true", "x-photon-version": "v2" };

async function logout(mw: PhotonMiddleware, store: Map<string, unknown>) {
	return serve(mw, {
		method: "POST",
		headers: spa,
		store,
		handler: async (photon) => {
			photon.clearHistory();
			return undefined;
		},
	});
}

const renderLogin = async (photon: PhotonContext) =>
	(await photon.render("Login", {})).html;

describe("photon > clearHistory across a redirect", () => {
	const orig = process.env.NODE_ENV;
	beforeEach(() => {
		process.env.NODE_ENV = "development";
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = orig;
	});

	it("reaches the X-Photon page after the redirect, once", async () => {
		const mw = new PhotonMiddleware(config);
		const store = new Map<string, unknown>();
		await logout(mw, store);

		const next = await serve(mw, {
			headers: spa,
			store,
			handler: renderLogin,
		});
		expect(JSON.parse(next.body ?? "{}").clearHistory).toBe(true);

		const after = await serve(mw, {
			headers: spa,
			store,
			handler: renderLogin,
		});
		expect(JSON.parse(after.body ?? "{}").clearHistory).toBeUndefined();
	});

	it("reaches a full page load after the redirect", async () => {
		const mw = new PhotonMiddleware(config);
		const store = new Map<string, unknown>();
		await logout(mw, store);

		const next = await serve(mw, { store, handler: renderLogin });
		expect(next.body).toContain('"clearHistory":true');
	});

	it("is not consumed by a stale-version 409, so the reload still gets it", async () => {
		const mw = new PhotonMiddleware(config);
		const store = new Map<string, unknown>();
		await logout(mw, store);

		const stale = await serve(mw, {
			headers: { "x-photon": "true", "x-photon-version": "v1" },
			store,
			handler: renderLogin,
		});
		expect(stale.status).toBe(409);

		const reload = await serve(mw, { store, handler: renderLogin });
		expect(reload.body).toContain('"clearHistory":true');
	});

	it("is consumed by a page rendered in the same request", async () => {
		const mw = new PhotonMiddleware(config);
		const store = new Map<string, unknown>();
		const same = await serve(mw, {
			headers: spa,
			store,
			handler: async (photon) => {
				photon.clearHistory();
				return (await photon.render("Login", {})).html;
			},
		});
		expect(JSON.parse(same.body ?? "{}").clearHistory).toBe(true);

		const after = await serve(mw, {
			headers: spa,
			store,
			handler: renderLogin,
		});
		expect(JSON.parse(after.body ?? "{}").clearHistory).toBeUndefined();
	});

	it("still flags the page of its own request without a session", async () => {
		const mw = new PhotonMiddleware(config);
		const page = await serve(mw, {
			headers: spa,
			handler: async (photon) => {
				photon.clearHistory();
				return (await photon.render("Login", {})).html;
			},
		});
		expect(JSON.parse(page.body ?? "{}").clearHistory).toBe(true);
	});
});
