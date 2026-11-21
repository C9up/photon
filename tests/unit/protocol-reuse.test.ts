/**
 * The protocol's server half used without photon's renderer — how aurora
 * answers its page visits: one implementation of the page object and of the
 * 302 / 409 / 303 answers.
 */
import { describe, expect, it } from "vitest";
import {
	buildPageObject,
	defer,
	finishVisit,
	merge,
	readRequestInfo,
} from "../../src/index.js";

function response(initialStatus?: number) {
	const written: { status?: number; headers: Record<string, string> } = {
		headers: {},
	};
	const res = {
		status(code: number) {
			written.status = code;
			return res;
		},
		header(k: string, v: string) {
			written.headers[k] = v;
		},
		send() {},
		getStatus: () => initialStatus,
	};
	return { res, written };
}

function request(headers: Record<string, string>, method = "GET") {
	return { request: { method: () => method, headers, url: "/dash" } };
}

describe("photon > the protocol without the renderer", () => {
	it("builds a page object for another framework, props resolved as on a first load", async () => {
		const { page } = await buildPageObject(
			"Dashboard",
			{
				when: new Date("2026-11-21T10:00:00Z"),
				stats: defer(() => ({ open: 3 })),
				rows: merge([1, 2]),
			},
			{ url: "/dash?tab=1", version: "v7", framework: "aurora" },
		);
		expect(page).toEqual({
			component: "Dashboard",
			// As the client receives it: a Date through JSON, the deferred prop left for later.
			props: { when: "2026-11-21T10:00:00.000Z", rows: [1, 2] },
			url: "/dash?tab=1",
			framework: "aurora",
			version: "v7",
			deferredProps: { default: ["stats"] },
			mergeProps: ["rows"],
		});
	});

	it("resolves what a partial reload asks for", async () => {
		const info = readRequestInfo(
			request({
				"x-photon": "true",
				"x-photon-partial-component": "Dashboard",
				"x-photon-partial-data": "stats",
			}),
		);
		const { page } = await buildPageObject(
			"Dashboard",
			{ title: "Board", stats: defer(() => ({ open: 3 })) },
			{
				url: "/dash",
				version: "v7",
				framework: "aurora",
				partial: info.partial,
			},
		);
		expect(page.props).toEqual({ stats: { open: 3 } });
	});

	it("answers a stale visit with a 409, a redirected mutation with a 303, and leaves the rest", () => {
		const stale = response();
		const info = readRequestInfo(
			request({ "x-photon": "true", "x-photon-version": "old" }),
		);
		expect(
			finishVisit({}, stale.res, info, { url: "/dash", version: "new" }),
		).toBe(true);
		expect(stale.written).toEqual({
			status: 409,
			headers: { "x-photon-location": "/dash", "x-photon-version": "new" },
		});

		const put = response(302);
		const mutation = readRequestInfo(request({ "x-photon": "true" }, "PUT"));
		expect(
			finishVisit({}, put.res, mutation, { url: "/dash", version: "new" }),
		).toBe(false);
		expect(put.written.status).toBe(303);

		const plain = response(200);
		const load = readRequestInfo(request({}));
		expect(
			finishVisit({}, plain.res, load, { url: "/dash", version: "new" }),
		).toBe(false);
		expect(plain.written.status).toBeUndefined();
		expect(
			finishVisit({}, plain.res, load, {
				url: "/dash",
				version: "new",
				location: "/login",
			}),
		).toBe(true);
		expect(plain.written).toEqual({
			status: 302,
			headers: { location: "/login" },
		});
	});
});
