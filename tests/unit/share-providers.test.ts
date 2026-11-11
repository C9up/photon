/**
 * Shared props can be providers, resolved when a page is built.
 *
 * A global middleware sharing the signed-in user must not compute it on a
 * request that renders no page, and must see what the handler did after the
 * share was registered. The middleware's `share(ctx)` / `flash(ctx)` hooks
 * are how an application registers them once for every request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhotonContext } from "../../src/PhotonContext.js";
import {
	PhotonMiddleware,
	type PhotonMiddlewareContext,
} from "../../src/PhotonMiddleware.js";
import { PhotonRenderer } from "../../src/PhotonRenderer.js";

const config = {
	framework: "react" as const,
	entryClient: "resources/app.tsx",
};

function pageDataOf(html: string): Record<string, unknown> {
	const match = /<script[^>]*id="photon-data">([^<]*)<\/script>/.exec(html);
	return JSON.parse(match?.[1] ?? "{}");
}

function harness(headers: Record<string, string> = {}) {
	const written: { status: number; headers: Record<string, string> } = {
		status: 200,
		headers: {},
	};
	const response = {
		status(code: number) {
			written.status = code;
			return response;
		},
		header(name: string, value: string) {
			written.headers[name.toLowerCase()] = value;
			return response;
		},
		send() {},
		getHeader(name: string) {
			return written.headers[name.toLowerCase()];
		},
	};
	const ctx: PhotonMiddlewareContext & { auth?: { user?: string } } = {
		request: {
			method: () => "GET",
			path: () => "/",
			header: (name: string) => headers[name.toLowerCase()],
		},
		response,
	};
	return { ctx, written };
}

describe("photon > share() providers", () => {
	const orig = process.env.NODE_ENV;
	beforeEach(() => {
		process.env.NODE_ENV = "development";
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = orig;
	});

	it("resolves a provider when the page is built, after later handler state", async () => {
		const ctx = createPhotonContext(new PhotonRenderer(config), "/");
		let user = "anonymous";
		ctx.share(() => ({ user }));
		ctx.share(async () => ({ locale: "fr" }));
		ctx.share({ plain: true });
		user = "ada";
		const page = pageDataOf((await ctx.render("Home", {})).html);
		expect(page.props).toEqual({ user: "ada", locale: "fr", plain: true });
		expect(page.sharedProps).toEqual(["user", "locale", "plain"]);
	});

	it("lets a later share and a per-call prop win over an earlier provider", async () => {
		const ctx = createPhotonContext(new PhotonRenderer(config), "/");
		ctx.share(() => ({ a: "provider", b: "provider" }));
		ctx.share({ b: "eager" });
		const page = pageDataOf((await ctx.render("Home", { a: "page" })).html);
		expect(page.props).toEqual({ a: "page", b: "eager" });
	});

	it("never calls a provider when no page is rendered", async () => {
		const provider = vi.fn(() => ({ user: "ada" }));
		const mw = new PhotonMiddleware(config);
		const { ctx } = harness();
		await mw.middleware()(ctx, async () => {
			ctx.photon?.share(provider);
		});
		expect(provider).not.toHaveBeenCalled();
	});

	it("resolves providers for an X-Photon props request too", async () => {
		const mw = new PhotonMiddleware(config);
		const { ctx } = harness({ "x-photon": "true" });
		let body = "";
		await mw.middleware()(ctx, async () => {
			ctx.photon?.share(async () => ({ user: "ada" }));
			body = (await ctx.photon?.render("Home", {}))?.html ?? "";
		});
		const page = JSON.parse(body);
		expect(page.props.user).toBe("ada");
		expect(page.sharedProps).toContain("user");
	});
});

describe("photon > PhotonMiddleware share()/flash() hooks", () => {
	const orig = process.env.NODE_ENV;
	beforeEach(() => {
		process.env.NODE_ENV = "development";
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = orig;
	});

	class AppPhotonMiddleware extends PhotonMiddleware {
		shareCalls = 0;
		override async share(ctx: PhotonMiddlewareContext) {
			this.shareCalls += 1;
			return { user: Reflect.get(Object(Reflect.get(ctx, "auth")), "user") };
		}
		override flash() {
			return { notice: "Saved" };
		}
	}

	it("shares the hook's props, resolved after the handler, and sends its flash", async () => {
		const mw = new AppPhotonMiddleware(config);
		const { ctx } = harness();
		let html = "";
		await mw.middleware()(ctx, async () => {
			// The handler signs the user in after the middleware registered.
			ctx.auth = { user: "ada" };
			html = (await ctx.photon?.render("Home", {}))?.html ?? "";
		});
		const page = pageDataOf(html);
		expect(page.props).toMatchObject({ user: "ada", errors: {} });
		expect(page.sharedProps).toContain("user");
		expect(page.flash).toEqual({ notice: "Saved" });
	});

	it("does not run the share hook on a request that renders no page", async () => {
		const mw = new AppPhotonMiddleware(config);
		const { ctx } = harness();
		await mw.middleware()(ctx, async () => {});
		expect(mw.shareCalls).toBe(0);
	});

	it("lets a handler's own flash() replace the hook's", async () => {
		const mw = new AppPhotonMiddleware(config);
		const { ctx } = harness();
		let html = "";
		await mw.middleware()(ctx, async () => {
			ctx.photon?.flash(() => ({ notice: "Deleted" }));
			html = (await ctx.photon?.render("Home", {}))?.html ?? "";
		});
		expect(pageDataOf(html).flash).toEqual({ notice: "Deleted" });
	});
});
