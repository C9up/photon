import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PhotonMiddleware,
	type PhotonMiddlewareContext,
} from "../../src/PhotonMiddleware.js";
import { PhotonRenderer } from "../../src/PhotonRenderer.js";

const baseConfig = {
	framework: "react" as const,
	entryClient: "resources/app.tsx",
	entryServer: "resources/ssr.tsx",
};

function makeCtx(opts: {
	path?: string;
	xPhoton?: string;
	contentType?: string;
}): {
	ctx: PhotonMiddlewareContext;
	res: { body?: string; status: number; headers: Record<string, string> };
} {
	const res = {
		body: undefined as string | undefined,
		status: 200,
		headers: {} as Record<string, string>,
	};
	const ctx: PhotonMiddlewareContext = {
		request: {
			method() {
				return "GET";
			},
			path() {
				return opts.path ?? "/";
			},
			header(name) {
				if (name === "x-photon") return opts.xPhoton;
				return undefined;
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
				if (name === "content-type") return opts.contentType;
				return undefined;
			},
		},
	};
	return { ctx, res };
}

describe("photon > PhotonMiddleware", () => {
	const orig = process.env.NODE_ENV;
	beforeEach(() => {
		process.env.NODE_ENV = "development";
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = orig;
	});

	it("attaches ctx.photon with a render() helper before next()", async () => {
		const mw = new PhotonMiddleware(baseConfig).middleware();
		const { ctx } = makeCtx({});
		let saw: PhotonMiddlewareContext["photon"];
		await mw(ctx, async () => {
			saw = ctx.photon;
		});
		expect(saw).toBeDefined();
		expect(typeof saw?.render).toBe("function");
	});

	it("renders full HTML when downstream produced text/html and X-Photon is absent", async () => {
		const mw = new PhotonMiddleware(baseConfig).middleware();
		const { ctx, res } = makeCtx({ contentType: "text/html" });
		await mw(ctx, async () => {
			const out = await ctx.photon?.render("Home", { x: 1 });
			// downstream would forward `out` into res — simulate that:
			(ctx.response as { send: (b: string) => void }).send(out?.html ?? "");
		});
		expect(res.body).toContain('id="photon-data"');
		expect(res.body).toContain('"component":"Home"');
	});

	it("rewrites HTML response into JSON props when X-Photon=true is set", async () => {
		const mw = new PhotonMiddleware(baseConfig).middleware();
		const { ctx, res } = makeCtx({
			path: "/users",
			xPhoton: "true",
			contentType: "text/html",
		});
		await mw(ctx, async () => {
			const out = await ctx.photon?.render("Users", { count: 2 });
			(ctx.response as { send: (b: string) => void }).send(out?.html ?? "");
		});
		// After mw, res.body must be JSON props (not the original HTML).
		const parsed = JSON.parse(res.body ?? "{}");
		expect(parsed).toMatchObject({
			component: "Users",
			props: { count: 2 },
			url: "/users",
			framework: "react",
		});
		expect(res.headers["x-photon"]).toBe("true");
	});

	it("does NOT rewrite when content-type is not text/html (e.g., raw JSON endpoint)", async () => {
		const mw = new PhotonMiddleware(baseConfig).middleware();
		const { ctx, res } = makeCtx({
			xPhoton: "true",
			contentType: "application/json",
		});
		await mw(ctx, async () => {
			(ctx.response as { send: (b: string) => void }).send('{"raw":1}');
		});
		expect(res.body).toBe('{"raw":1}');
	});

	it("does NOT rewrite when ctx.photon.render() was never called", async () => {
		const mw = new PhotonMiddleware(baseConfig).middleware();
		const { ctx, res } = makeCtx({
			xPhoton: "true",
			contentType: "text/html",
		});
		await mw(ctx, async () => {
			(ctx.response as { send: (b: string) => void }).send("<p>raw</p>");
		});
		expect(res.body).toBe("<p>raw</p>");
	});

	it("boots the renderer only once across many requests (boot latch)", async () => {
		// vi.spyOn binds against the real prototype member — if PhotonRenderer
		// renames `boot()`, the spy setup throws (no silent test rot).
		const spy = vi
			.spyOn(PhotonRenderer.prototype, "boot")
			.mockResolvedValue(undefined);
		try {
			const mw = new PhotonMiddleware(baseConfig).middleware();
			await mw(makeCtx({}).ctx, async () => {});
			await mw(makeCtx({}).ctx, async () => {});
			await mw(makeCtx({}).ctx, async () => {});
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("re-attempts boot on the next request when a prior boot threw", async () => {
		const spy = vi
			.spyOn(PhotonRenderer.prototype, "boot")
			.mockRejectedValueOnce(new Error("first boot failed"))
			.mockResolvedValue(undefined);
		try {
			const mw = new PhotonMiddleware(baseConfig).middleware();
			await expect(mw(makeCtx({}).ctx, async () => {})).rejects.toThrow(
				/first boot failed/,
			);
			await mw(makeCtx({}).ctx, async () => {});
			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
		}
	});
});
