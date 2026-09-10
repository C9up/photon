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

/** A context shaped like the one the middleware serves a request on. */
function requestContext(
	headers: Record<string, string> = {},
	path = "/",
): PhotonMiddlewareContext {
	const ctx: PhotonMiddlewareContext = {
		request: {
			method: () => "GET",
			path: () => path,
			header: (name) => headers[name],
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
	return ctx;
}

describe("photon > ssr.pages receives the request", () => {
	it("hands the predicate the context the middleware is serving", async () => {
		let seen: SsrRequestContext | undefined;
		const renderer = new PhotonRenderer({
			...base,
			ssr: {
				pages: (_component, ctx) => {
					seen = ctx;
					return true;
				},
			},
		});
		const httpCtx = requestContext();
		await createPhotonContext(renderer, "/dashboard", httpCtx).ssrEnabled(
			"Dashboard",
		);
		expect(seen).toBe(httpCtx);
	});

	it("lets the decision turn on the request, with no assertion needed", async () => {
		const renderer = new PhotonRenderer({
			...base,
			ssr: {
				// Reads straight off the context — that it typechecks IS the point.
				pages: (_component, ctx) =>
					/bot|crawler/i.test(ctx?.request?.header("user-agent") ?? ""),
			},
		});

		const crawler = requestContext({ "user-agent": "Googlebot/2.1" });
		const browser = requestContext({ "user-agent": "Mozilla/5.0" });
		// The same component, two answers — which is the whole point.
		expect(
			await createPhotonContext(renderer, "/p", crawler).ssrEnabled("Post"),
		).toBe(true);
		expect(
			await createPhotonContext(renderer, "/p", browser).ssrEnabled("Post"),
		).toBe(false);
	});

	/**
	 * Overlapping requests each keep their own context.
	 *
	 * Being a per-call argument, rather than state on the shared renderer, is
	 * what makes that so — and also why no mutation of this code can fail this
	 * test: the property is structural, not defended by a branch. It is here to
	 * say what the design guarantees, and it would catch a future rewrite that
	 * moved the context onto the renderer.
	 */
	it("keeps two CONCURRENT requests apart", async () => {
		const seen: Array<string | undefined> = [];
		const renderer = new PhotonRenderer({
			...base,
			ssr: {
				pages: async (_component, ctx) => {
					const id = ctx?.request?.header("x-request-id");
					// The two predicates overlap: this one yields while the other
					// runs. Each still sees its own request.
					await new Promise((resolve) => setTimeout(resolve, 5));
					seen.push(
						id === ctx?.request?.header("x-request-id") ? id : "LEAKED",
					);
					return true;
				},
			},
		});

		// One renderer, two requests genuinely in flight at once.
		await Promise.all([
			createPhotonContext(
				renderer,
				"/a",
				requestContext({ "x-request-id": "a" }),
			).ssrEnabled("A"),
			createPhotonContext(
				renderer,
				"/b",
				requestContext({ "x-request-id": "b" }),
			).ssrEnabled("B"),
		]);
		expect([...seen].sort()).toEqual(["a", "b"]);
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
		let seen: SsrRequestContext | undefined;
		const mw = new PhotonMiddleware({
			...base,
			ssr: {
				pages: (_component, ctx) => {
					seen = ctx;
					return true;
				},
			},
		}).middleware();

		const ctx = requestContext({}, "/dashboard");
		await mw(ctx, async () => {
			// Inside the pipeline, where a controller would render.
			await ctx.photon?.ssrEnabled("Dashboard");
		});

		// Building the context by hand proves the plumbing; this proves the
		// middleware hands it over, which is the only path an app takes.
		expect(seen).toBe(ctx);
	});
});
