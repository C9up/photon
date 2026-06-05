import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PhotonMiddleware,
	type PhotonMiddlewareContext,
} from "../../src/PhotonMiddleware.js";
import { Meta } from "../../src/seo/MetaDecorator.js";

const baseConfig = {
	framework: "react" as const,
	entryClient: "resources/app.tsx",
	entryServer: "resources/ssr.tsx",
};

interface CapturedResponse {
	body?: string;
	status: number;
	headers: Record<string, string>;
}

function makeCtx(opts: {
	path?: string;
	xPhoton?: string;
	contentType?: string;
	route?: PhotonMiddlewareContext["route"];
}): { ctx: PhotonMiddlewareContext; res: CapturedResponse } {
	const res: CapturedResponse = { status: 200, headers: {} };
	const ctx: PhotonMiddlewareContext = {
		request: {
			method() {
				return "GET";
			},
			path() {
				return opts.path ?? "/";
			},
			header(name) {
				return name === "x-photon" ? opts.xPhoton : undefined;
			},
		},
		response: {
			status(code) {
				res.status = code;
				return ctx.response;
			},
			header(name, value) {
				res.headers[name] = value;
				return ctx.response;
			},
			send(body) {
				res.body = body;
			},
			getHeader(name) {
				return name === "content-type" ? opts.contentType : undefined;
			},
		},
		route: opts.route,
	};
	return { ctx, res };
}

describe("photon > PhotonMiddleware > meta accumulator", () => {
	const orig = process.env.NODE_ENV;
	beforeEach(() => {
		process.env.NODE_ENV = "development";
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = orig;
	});

	it("ctx.photon.meta() accumulates across multiple calls; render() emits the merged tags", async () => {
		const mw = new PhotonMiddleware(baseConfig).middleware();
		const { ctx } = makeCtx({});
		let captured: { html: string } | undefined;
		await mw(ctx, async () => {
			ctx.photon?.meta({ title: "First" });
			ctx.photon?.meta({ description: "Desc", title: "Second" });
			captured = await ctx.photon?.render("Home", {});
		});
		expect(captured?.html).toContain("<title>Second</title>");
		expect(captured?.html).toContain(
			'<meta name="description" content="Desc">',
		);
	});

	it("an explicit meta arg to render() wins over the accumulator", async () => {
		const mw = new PhotonMiddleware(baseConfig).middleware();
		const { ctx } = makeCtx({});
		let captured: { html: string } | undefined;
		await mw(ctx, async () => {
			ctx.photon?.meta({ title: "From accumulator" });
			captured = await ctx.photon?.render("Home", {}, { title: "From call" });
		});
		expect(captured?.html).toContain("<title>From call</title>");
		expect(captured?.html).not.toContain("<title>From accumulator</title>");
	});

	it("@Meta() decorator on a controller method seeds the accumulator", async () => {
		class HomeController {
			@Meta({ title: "From decorator", description: "D" })
			index(): void {}
		}
		const mw = new PhotonMiddleware(baseConfig).middleware();
		const { ctx } = makeCtx({
			route: { controller: HomeController.prototype, action: "index" },
		});
		let captured: { html: string } | undefined;
		await mw(ctx, async () => {
			captured = await ctx.photon?.render("Home", {});
		});
		expect(captured?.html).toContain("<title>From decorator</title>");
		expect(captured?.html).toContain('<meta name="description" content="D">');
	});

	it("imperative `ctx.photon.meta()` overrides decorator metadata", async () => {
		class C {
			@Meta({ title: "Decorator", description: "Decorator" })
			handler(): void {}
		}
		const mw = new PhotonMiddleware(baseConfig).middleware();
		const { ctx } = makeCtx({
			route: { controller: C.prototype, action: "handler" },
		});
		let captured: { html: string } | undefined;
		await mw(ctx, async () => {
			ctx.photon?.meta({ title: "Imperative" });
			captured = await ctx.photon?.render("Home", {});
		});
		expect(captured?.html).toContain("<title>Imperative</title>");
		// Description fell through from decorator (un-overridden).
		expect(captured?.html).toContain(
			'<meta name="description" content="Decorator">',
		);
	});

	it("@Meta(fn) factory is awaited with the request context", async () => {
		class C {
			@Meta((ctx: PhotonMiddlewareContext) => ({
				canonical: `https://example.com${ctx.request?.path?.() ?? ""}`,
			}))
			show(): void {}
		}
		const mw = new PhotonMiddleware(baseConfig).middleware();
		const { ctx } = makeCtx({
			path: "/article/42",
			route: { controller: C.prototype, action: "show" },
		});
		let captured: { html: string } | undefined;
		await mw(ctx, async () => {
			captured = await ctx.photon?.render("Show", {});
		});
		expect(captured?.html).toContain(
			'<link rel="canonical" href="https://example.com/article/42">',
		);
	});

	it("when neither route nor decorator nor imperative meta, head is empty of SEO tags", async () => {
		const mw = new PhotonMiddleware(baseConfig).middleware();
		const { ctx } = makeCtx({});
		let captured: { html: string } | undefined;
		await mw(ctx, async () => {
			captured = await ctx.photon?.render("Home", {});
		});
		const headBlock = captured?.html.split("</head>")[0] ?? "";
		expect(headBlock).not.toMatch(/<title>/);
		expect(headBlock).not.toMatch(/property="og:/);
	});

	it("a throwing decorator factory does NOT abort the request — it logs and degrades", async () => {
		class C {
			@Meta(() => {
				throw new Error("boom from decorator");
			})
			handler(): void {}
		}
		// Spy console.warn to verify the failure surfaced as a log, not a 500.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const mw = new PhotonMiddleware(baseConfig).middleware();
			const { ctx } = makeCtx({
				route: { controller: C.prototype, action: "handler" },
			});
			let captured: { html: string } | undefined;
			await mw(ctx, async () => {
				ctx.photon?.meta({ title: "Imperative still works" });
				captured = await ctx.photon?.render("Home", {});
			});
			// Request completed; head carries the imperative override.
			expect(captured?.html).toContain("<title>Imperative still works</title>");
			// Warning was emitted (precise format — message + action name).
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0]?.[0]).toMatch(/@Meta resolver threw/);
			expect(warnSpy.mock.calls[0]?.[0]).toMatch(/handler/);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
