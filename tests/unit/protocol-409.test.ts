/**
 * The two 409 flows and the 303 upgrade — AdonisJS Inertia protocol semantics.
 *
 * A 409 is how the server tells an SPA client to stop fetching and navigate for
 * real. A plain 302 cannot do it: the client would follow it with its own fetch
 * and receive HTML it has no way to mount.
 */
import { describe, expect, it } from "vitest";
import { PhotonMiddleware } from "../../src/PhotonMiddleware.js";

const baseConfig = {
	framework: "react" as const,
	entryClient: "resources/app.tsx",
};

function harness(
	headers: Record<string, string>,
	method = "GET",
	initialStatus?: number,
) {
	const written: { status?: number; headers: Record<string, string> } = {
		headers: {},
	};
	const res: Record<string, unknown> = {
		status: (code: number) => {
			written.status = code;
			return res;
		},
		header: (k: string, v: string) => {
			written.headers[k] = v;
		},
		send: () => {},
		getHeader: (n: string) => (n === "content-type" ? "text/html" : undefined),
		getStatus: () => initialStatus,
	};
	const ctx: Record<string, unknown> = {
		request: { method: () => method, headers, url: "/dash" },
		response: res,
	};
	return { ctx, res, written };
}

async function run(
	mw: PhotonMiddleware,
	ctx: Record<string, unknown>,
	render?: () => Promise<unknown>,
) {
	await mw.middleware()(ctx, async () => {
		if (render) await render();
	});
}

describe("photon > 409 protocol flows", () => {
	it("answers location() with 409 and the target", async () => {
		const mw = new PhotonMiddleware(baseConfig);
		const { ctx, written } = harness({ "x-photon": "true" });
		await run(mw, ctx, async () => {
			const photon = Reflect.get(Object(ctx), "photon");
			Reflect.get(Object(photon), "location").call(
				photon,
				"https://pay.example",
			);
		});
		expect(written.status).toBe(409);
		expect(written.headers["x-photon-location"]).toBe("https://pay.example");
	});

	it("answers location() on a plain browser request with a 302 to the target", async () => {
		const mw = new PhotonMiddleware(baseConfig);
		const { ctx, written } = harness({});
		await run(mw, ctx, async () => {
			const photon = Reflect.get(Object(ctx), "photon");
			Reflect.get(Object(photon), "location").call(
				photon,
				"https://sso.example/authorize",
			);
		});
		// The first visit has no client router to read a 409: the browser
		// follows the redirect itself, and the target is never dropped.
		expect(written.status).toBe(302);
		expect(written.headers.location).toBe("https://sso.example/authorize");
		expect(written.headers["x-photon-location"]).toBeUndefined();
	});

	it("forces a reload when the client's asset version is stale", async () => {
		const mw = new PhotonMiddleware(baseConfig);
		const { ctx, written } = harness({
			"x-photon": "true",
			"x-photon-version": "outdated",
		});
		await run(mw, ctx);
		expect(written.status).toBe(409);
		expect(written.headers["x-photon-version"]).toBeDefined();
	});

	it("leaves a client that sends no version alone", async () => {
		const mw = new PhotonMiddleware(baseConfig);
		const { ctx, written } = harness({ "x-photon": "true" });
		await run(mw, ctx);
		expect(written.status).not.toBe(409);
	});

	it("does not force a reload on a mutation", async () => {
		const mw = new PhotonMiddleware(baseConfig);
		const { ctx, written } = harness(
			{ "x-photon": "true", "x-photon-version": "outdated" },
			"POST",
		);
		await run(mw, ctx);
		expect(written.status).not.toBe(409);
	});

	it("upgrades a 302 after a mutation to 303", async () => {
		const mw = new PhotonMiddleware(baseConfig);
		const { ctx, written } = harness({ "x-photon": "true" }, "DELETE", 302);
		await run(mw, ctx);
		expect(written.status).toBe(303);
	});

	it("leaves a 302 after a GET alone", async () => {
		const mw = new PhotonMiddleware(baseConfig);
		const { ctx, written } = harness({ "x-photon": "true" }, "GET", 302);
		await run(mw, ctx);
		expect(written.status).not.toBe(303);
	});

	it("reflashes the session on a stale-version reload", async () => {
		// The messages this request consumed must survive the hard reload,
		// or a "Saved" landing right after a deploy is never shown.
		const mw = new PhotonMiddleware(baseConfig);
		const { ctx, written } = harness({
			"x-photon": "true",
			"x-photon-version": "outdated",
		});
		let reflashes = 0;
		ctx.session = {
			reflash: () => {
				reflashes += 1;
			},
		};
		await run(mw, ctx);
		expect(written.status).toBe(409);
		expect(reflashes).toBe(1);
	});

	it("does not reflash for an explicit location()", async () => {
		const mw = new PhotonMiddleware(baseConfig);
		const { ctx, written } = harness({ "x-photon": "true" });
		let reflashes = 0;
		ctx.session = {
			reflash: () => {
				reflashes += 1;
			},
		};
		await run(mw, ctx, async () => {
			const photon = Reflect.get(Object(ctx), "photon");
			Reflect.get(Object(photon), "location").call(photon, "/elsewhere");
		});
		expect(written.status).toBe(409);
		expect(reflashes).toBe(0);
	});

	it("answers a stale version without a session", async () => {
		const mw = new PhotonMiddleware(baseConfig);
		const { ctx, written } = harness({
			"x-photon": "true",
			"x-photon-version": "outdated",
		});
		ctx.session = {};
		await run(mw, ctx);
		expect(written.status).toBe(409);
	});

	it("ignores all of it for a non-SPA request", async () => {
		const mw = new PhotonMiddleware(baseConfig);
		const { ctx, written } = harness({}, "DELETE", 302);
		await run(mw, ctx);
		expect(written.status).toBeUndefined();
	});
});
