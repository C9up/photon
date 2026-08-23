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
	entryServer: "resources/ssr.tsx",
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

	it("ignores all of it for a non-SPA request", async () => {
		const mw = new PhotonMiddleware(baseConfig);
		const { ctx, written } = harness({}, "DELETE", 302);
		await run(mw, ctx);
		expect(written.status).toBeUndefined();
	});
});
