import { Response } from "@c9up/ream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PhotonMiddleware,
	type PhotonMiddlewareContext,
} from "../../src/PhotonMiddleware.js";

/**
 * The middleware against Ream's own Response, not a mock of it.
 *
 * Ream's Response keeps its state in private fields, so a method called off
 * it — `const send = res.send; send(body)` — throws. Mocks made of closures
 * cannot tell the difference, which is how every SPA navigation came to throw
 * with all the tests green.
 */

const config = {
	framework: "react" as const,
	entryClient: "resources/app.tsx",
	entryServer: "resources/ssr.tsx",
};

function makeCtx(headers: Record<string, string>): {
	ctx: PhotonMiddlewareContext;
	response: Response;
} {
	const response = new Response();
	const ctx: PhotonMiddlewareContext = {
		request: {
			method: () => "GET",
			path: () => "/users",
			header: (name: string) => headers[name],
		},
		response,
	};
	return { ctx, response };
}

describe("photon > PhotonMiddleware > with Ream's Response", () => {
	const orig = process.env.NODE_ENV;
	beforeEach(() => {
		process.env.NODE_ENV = "development";
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = orig;
	});

	it("answers an SPA navigation with the props as JSON", async () => {
		const mw = new PhotonMiddleware(config).middleware();
		const { ctx, response } = makeCtx({ "x-photon": "true" });
		await mw(ctx, async () => {
			const out = await ctx.photon?.render("Users", { count: 2 });
			response.header("content-type", "text/html; charset=utf-8");
			response.send(out?.html ?? "");
		});
		expect(response.getStatus()).toBe(200);
		expect(response.getHeader("content-type")).toBe("application/json");
		expect(JSON.parse(response.getBody())).toMatchObject({
			component: "Users",
			props: { count: 2 },
		});
	});

	it("carries the shared props, errors included, as a page load does", async () => {
		const mw = new PhotonMiddleware(config).middleware();
		const { ctx, response } = makeCtx({ "x-photon": "true" });
		await mw(ctx, async () => {
			ctx.photon?.share({ auth: { user: "ada" } });
			const out = await ctx.photon?.render("Users", { count: 2 });
			response.header("content-type", "text/html; charset=utf-8");
			response.send(out?.html ?? "");
		});
		const page = JSON.parse(response.getBody());
		expect(page.props).toEqual({
			errors: {},
			auth: { user: "ada" },
			count: 2,
		});
		expect(page.sharedProps).toEqual(["errors", "auth"]);
	});

	it("varies every response on X-Photon, keeping what the app set", async () => {
		const mw = new PhotonMiddleware(config).middleware();
		const requests: Record<string, string>[] = [{}, { "x-photon": "true" }];
		for (const headers of requests) {
			const { ctx, response } = makeCtx(headers);
			response.vary("Accept-Encoding");
			await mw(ctx, async () => {
				const out = await ctx.photon?.render("Users", {});
				response.header("content-type", "text/html; charset=utf-8");
				response.send(out?.html ?? "");
			});
			expect(response.getHeader("vary")).toBe("Accept-Encoding, X-Photon");
		}
	});

	it("answers a stale asset version with a 409", async () => {
		const mw = new PhotonMiddleware(config).middleware();
		const { ctx, response } = makeCtx({
			"x-photon": "true",
			"x-photon-version": "stale",
		});
		await mw(ctx, async () => {});
		expect(response.getStatus()).toBe(409);
		expect(response.getHeader("x-photon-location")).toBe("/users");
	});
});
