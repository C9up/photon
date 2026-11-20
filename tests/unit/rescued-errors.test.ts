/**
 * A deferred prop with `rescue: true` keeps the page alive when its resolver
 * throws — and the error is still REPORTED, out of band: to the request's
 * logger by default, or to the listener `onRescue()` installs. Swallowing it
 * left a failing panel invisible to whoever runs the application.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPhotonContext } from "../../src/PhotonContext.js";
import type { PhotonMiddlewareContext } from "../../src/PhotonMiddleware.js";
import { PhotonRenderer } from "../../src/PhotonRenderer.js";
import { defer } from "../../src/props.js";
import { onRescue } from "../../src/rescue.js";

const boom = new Error("lost connection");

function context(logger?: { error: (...args: unknown[]) => void }) {
	const renderer = new PhotonRenderer({
		framework: "react",
		entryClient: "app.tsx",
		dev: true,
	});
	const headers: Record<string, string> = {
		"x-photon": "true",
		"x-photon-partial-component": "Dashboard",
		"x-photon-partial-data": "stats",
	};
	const ctx: PhotonMiddlewareContext & { logger?: unknown } = {
		request: {
			method: () => "GET",
			path: () => "/dashboard",
			header: (name: string) => headers[name.toLowerCase()],
		},
		...(logger ? { logger } : {}),
	};
	return { photon: createPhotonContext(renderer, "/dashboard", ctx), ctx };
}

const props = () => ({
	stats: defer(
		() => {
			throw boom;
		},
		{ rescue: true },
	),
});

afterEach(() => {
	onRescue();
	vi.restoreAllMocks();
});

describe("photon > rescued deferred props are reported", () => {
	it("logs the error through the request's logger by default", async () => {
		const calls: unknown[][] = [];
		const { photon } = context({ error: (...args) => calls.push(args) });
		const result = await photon.render("Dashboard", props());
		expect(JSON.parse(result.html)).toMatchObject({ rescuedProps: ["stats"] });
		expect(calls).toEqual([[{ err: boom }, 'Rescued deferred prop "stats"']]);
	});

	it("falls back to console.error when the context has no logger", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { photon } = context();
		await photon.render("Dashboard", props());
		expect(spy).toHaveBeenCalledWith(
			'[photon] Rescued deferred prop "stats"',
			boom,
		);
	});

	it("hands each error to the listener onRescue() installs, then restores the default", async () => {
		const seen: { error: unknown; prop: string; ctx: unknown }[] = [];
		onRescue((error, { prop, ctx }) => seen.push({ error, prop, ctx }));
		const { photon, ctx } = context({ error: () => {} });
		const result = await photon.render("Dashboard", props());
		expect(JSON.parse(result.html).props).toEqual({});
		expect(seen).toEqual([{ error: boom, prop: "stats", ctx }]);

		onRescue();
		const calls: unknown[][] = [];
		await context({ error: (...args) => calls.push(args) }).photon.render(
			"Dashboard",
			props(),
		);
		expect(calls).toHaveLength(1);
	});
});
