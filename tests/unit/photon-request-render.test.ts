/**
 * A props request is answered from ONE resolution of the props.
 *
 * The page object is built once, against the request: an X-Photon visit gets
 * the JSON page and never reaches the SSR bundle or the HTML document, and a
 * partial reload resolves only the props it names.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PhotonContext } from "../../src/PhotonContext.js";
import {
	PhotonMiddleware,
	type PhotonMiddlewareContext,
} from "../../src/PhotonMiddleware.js";
import type { ViteDevServerLike } from "../../src/PhotonRenderer.js";
import { optional } from "../../src/props.js";

const config = {
	framework: "react" as const,
	entryClient: "resources/app.tsx",
	ssr: { enabled: true, entrypoint: "resources/ssr.tsx" },
};

interface Written {
	status: number;
	headers: Record<string, string>;
	body?: string;
}

function harness(headers: Record<string, string>, method = "GET") {
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
			method: () => method,
			path: () => "/dash",
			header: (name: string) => headers[name.toLowerCase()],
		},
		response,
	};
	return { ctx, written };
}

function fakeSsr() {
	const state = { renders: 0 };
	const server: ViteDevServerLike = {
		ssrLoadModule() {
			return Promise.resolve({
				render: () => {
					state.renders += 1;
					return "<main>ssr</main>";
				},
			});
		},
		close: () => Promise.resolve(),
	};
	return { server, state };
}

async function serve(
	headers: Record<string, string>,
	props: Record<string, unknown>,
	extra?: (photon: PhotonContext) => void,
) {
	const mw = new PhotonMiddleware(config);
	const ssr = fakeSsr();
	// biome-ignore lint/correctness/useHookAtTopLevel: a renderer method, not a React hook
	mw.getRenderer().useDevServer(ssr.server);
	const { ctx, written } = harness(headers);
	await mw.middleware()(ctx, async () => {
		const photon = ctx.photon;
		if (photon === undefined) throw new Error("ctx.photon was not attached");
		extra?.(photon);
		const result = await photon.render("Dash", props);
		ctx.response?.status(result.status);
		for (const [k, v] of Object.entries(result.headers)) {
			ctx.response?.header(k, v);
		}
		ctx.response?.send(result.html);
	});
	return { written, ssr: ssr.state };
}

describe("photon > one render per request", () => {
	const orig = process.env.NODE_ENV;
	beforeEach(() => {
		process.env.NODE_ENV = "development";
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = orig;
	});

	it("answers an X-Photon visit without the SSR bundle, resolving each prop once", async () => {
		const calls = { stats: 0, heavy: 0 };
		const { written, ssr } = await serve(
			{ "x-photon": "true" },
			{
				stats: () => {
					calls.stats += 1;
					return 1;
				},
				heavy: async () => {
					calls.heavy += 1;
					return 2;
				},
			},
		);
		expect(ssr.renders).toBe(0);
		expect(calls).toEqual({ stats: 1, heavy: 1 });
		expect(written.headers["content-type"]).toBe("application/json");
		expect(written.headers["x-photon"]).toBe("true");
		expect(JSON.parse(written.body ?? "{}")).toMatchObject({
			component: "Dash",
			props: { stats: 1, heavy: 2 },
		});
	});

	it("never runs the resolver of a prop a partial reload left out", async () => {
		const calls = { stats: 0, heavy: 0 };
		const { written, ssr } = await serve(
			{
				"x-photon": "true",
				"x-photon-partial-component": "Dash",
				"x-photon-partial-data": "stats",
			},
			{
				stats: () => {
					calls.stats += 1;
					return 1;
				},
				heavy: () => {
					calls.heavy += 1;
					return 2;
				},
			},
		);
		expect(ssr.renders).toBe(0);
		expect(calls).toEqual({ stats: 1, heavy: 0 });
		expect(JSON.parse(written.body ?? "{}").props).toEqual({ stats: 1 });
	});

	it("resolves an optional prop a partial reload names, once", async () => {
		let audits = 0;
		const { written } = await serve(
			{
				"x-photon": "true",
				"x-photon-partial-component": "Dash",
				"x-photon-partial-data": "audit",
			},
			{
				audit: optional(() => {
					audits += 1;
					return ["log"];
				}),
			},
		);
		expect(audits).toBe(1);
		expect(JSON.parse(written.body ?? "{}").props).toEqual({ audit: ["log"] });
	});

	it("calls the flash provider once per X-Photon response", async () => {
		let flashes = 0;
		const { written } = await serve({ "x-photon": "true" }, {}, (photon) => {
			photon.flash(() => {
				flashes += 1;
				return { notice: "Saved" };
			});
		});
		expect(flashes).toBe(1);
		expect(JSON.parse(written.body ?? "{}").flash).toEqual({
			notice: "Saved",
		});
	});

	it("keeps a shared prop in the X-Photon payload and lists its key", async () => {
		const { written } = await serve({ "x-photon": "true" }, {}, (photon) => {
			photon.share({ user: "ada" });
		});
		const page = JSON.parse(written.body ?? "{}");
		expect(page.props).toMatchObject({ user: "ada", errors: {} });
		expect(page.sharedProps).toEqual(["errors", "user"]);
	});

	it("still server-renders a plain visit once, as HTML", async () => {
		let stats = 0;
		const { written, ssr } = await serve(
			{},
			{
				stats: () => {
					stats += 1;
					return 1;
				},
			},
		);
		expect(ssr.renders).toBe(1);
		expect(stats).toBe(1);
		expect(written.headers["content-type"]).toContain("text/html");
		expect(written.body).toContain("<main>ssr</main>");
	});
});
