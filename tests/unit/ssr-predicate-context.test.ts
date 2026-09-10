/**
 * An `ssr.pages` predicate decides per request, not per component name.
 *
 * Upstream hands the HTTP context to that callback, so the decision can turn
 * on a header, the authenticated user, a feature flag. Photon passed the
 * component alone and told callers to gate in middleware instead — which is a
 * different thing: middleware owns the whole response, where this owns only
 * whether THIS component is server-rendered.
 */
import { describe, expect, it } from "vitest";
import { createPhotonContext } from "../../src/PhotonContext.js";
import {
	PhotonMiddleware,
	type PhotonMiddlewareContext,
} from "../../src/PhotonMiddleware.js";
import {
	type PhotonConfig,
	PhotonRenderer,
	type SsrRequestContext,
} from "../../src/PhotonRenderer.js";

const base: PhotonConfig = {
	framework: "react",
	entryClient: "resources/app.tsx",
	entryServer: "resources/ssr.tsx",
};

describe("photon > ssr.pages receives the request", () => {
	it("hands the predicate the context the middleware is serving", async () => {
		let seen: SsrRequestContext;
		const renderer = new PhotonRenderer({
			...base,
			ssr: {
				pages: (_component, ctx) => {
					seen = ctx;
					return true;
				},
			},
		});
		const httpCtx = { request: { header: () => "yes" } };
		const context = createPhotonContext(renderer, "/dashboard", httpCtx);

		await context.ssrEnabled("Dashboard");
		expect(seen).toBe(httpCtx);
	});

	it("lets the decision turn on the request", async () => {
		const renderer = new PhotonRenderer({
			...base,
			ssr: {
				pages: (_component, ctx) =>
					typeof ctx === "object" &&
					ctx !== null &&
					"crawler" in ctx &&
					ctx.crawler === true,
			},
		});

		const forCrawler = createPhotonContext(renderer, "/p", { crawler: true });
		const forBrowser = createPhotonContext(renderer, "/p", { crawler: false });
		// The same component, two answers — which is the whole point.
		expect(await forCrawler.ssrEnabled("Post")).toBe(true);
		expect(await forBrowser.ssrEnabled("Post")).toBe(false);
	});

	it("keeps the renderer a singleton — nothing is stored on it", async () => {
		const seen: unknown[] = [];
		const renderer = new PhotonRenderer({
			...base,
			ssr: {
				pages: (_component, ctx) => {
					seen.push(ctx);
					return true;
				},
			},
		});
		// Two requests through ONE renderer. If the context were held on the
		// renderer, the second would see the first's — a cross-request leak.
		await createPhotonContext(renderer, "/a", { id: 1 }).ssrEnabled("A");
		await createPhotonContext(renderer, "/b", { id: 2 }).ssrEnabled("B");
		expect(seen).toEqual([{ id: 1 }, { id: 2 }]);
	});

	it("still works for a predicate that ignores the context", async () => {
		const renderer = new PhotonRenderer({
			...base,
			ssr: { pages: (component) => component === "Home" },
		});
		const context = createPhotonContext(renderer, "/", undefined);
		expect(await context.ssrEnabled("Home")).toBe(true);
		expect(await context.ssrEnabled("Other")).toBe(false);
	});
});

describe("photon > the middleware is what supplies the context", () => {
	it("passes the very ctx it is serving to the predicate", async () => {
		let seen: SsrRequestContext;
		const mw = new PhotonMiddleware({
			...base,
			ssr: {
				pages: (_component, ctx) => {
					seen = ctx;
					return true;
				},
			},
		}).middleware();

		const ctx: PhotonMiddlewareContext = {
			request: {
				method: () => "GET",
				path: () => "/dashboard",
				header: () => undefined,
			},
			response: {
				status() {
					return ctx.response;
				},
				header() {
					return ctx.response;
				},
				send() {},
				getHeader: () => undefined,
			},
		};

		await mw(ctx, async () => {
			// Inside the pipeline, where a controller would render.
			await ctx.photon?.ssrEnabled("Dashboard");
		});

		// Building the context by hand proves the plumbing; this proves the
		// middleware hands it over, which is the only path an app takes.
		expect(seen).toBe(ctx);
	});
});
