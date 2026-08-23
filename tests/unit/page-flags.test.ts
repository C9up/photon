/**
 * Response-level page fields: history control, the flash bag, per-page SSR and
 * scoped validation errors — the AdonisJS Inertia semantics a migrated
 * controller and its page component depend on.
 */
import { describe, expect, it } from "vitest";
import { createPhotonContext } from "../../src/PhotonContext.js";
import { getValidationErrors } from "../../src/PhotonMiddleware.js";
import { PhotonRenderer } from "../../src/PhotonRenderer.js";

function context() {
	// The renderer is never booted here: these assertions are about the flags
	// the context accumulates, not about rendering.
	const renderer = new PhotonRenderer({
		framework: "react",
		entryClient: "app.tsx",
		entryServer: "ssr.tsx",
	});
	return createPhotonContext(renderer, "/");
}

describe("photon > history flags", () => {
	it("says nothing at all when neither was asked for", async () => {
		expect(await context().resolvePageFlags()).toEqual({});
	});

	it("asks the client to drop its cached history", async () => {
		const ctx = context();
		ctx.clearHistory();
		expect(await ctx.resolvePageFlags()).toEqual({ clearHistory: true });
	});

	it("asks the client to encrypt its history", async () => {
		const ctx = context();
		ctx.encryptHistory();
		expect(await ctx.resolvePageFlags()).toEqual({ encryptHistory: true });
	});

	it("lets encryption be turned back off", async () => {
		const ctx = context();
		ctx.encryptHistory(true);
		ctx.encryptHistory(false);
		expect(await ctx.resolvePageFlags()).toEqual({});
	});
});

describe("photon > flash", () => {
	it("resolves the provider into a field beside the props", async () => {
		const ctx = context();
		ctx.flash(() => ({ notice: "Saved" }));
		expect(await ctx.resolvePageFlags()).toEqual({
			flash: { notice: "Saved" },
		});
	});

	it("awaits an async provider", async () => {
		const ctx = context();
		ctx.flash(async () => ({ notice: "Saved" }));
		expect(await ctx.resolvePageFlags()).toEqual({
			flash: { notice: "Saved" },
		});
	});

	it("keeps the last registration", async () => {
		const ctx = context();
		ctx.flash(() => "first");
		ctx.flash(() => "second");
		expect(await ctx.resolvePageFlags()).toEqual({ flash: "second" });
	});
});

describe("photon > per-page SSR", () => {
	const renderer = (ssr?: {
		enabled?: boolean;
		pages?: string[] | ((c: string) => boolean);
	}): PhotonRenderer =>
		new PhotonRenderer({
			framework: "react",
			entryClient: "app.tsx",
			entryServer: "ssr.tsx",
			ssr,
		});

	it("renders every page when nothing is configured", async () => {
		expect(await renderer().ssrEnabled("Anything")).toBe(true);
	});

	it("renders none when disabled", async () => {
		expect(await renderer({ enabled: false }).ssrEnabled("Home")).toBe(false);
	});

	it("narrows to a list of pages", async () => {
		const r = renderer({ pages: ["Home"] });
		expect(await r.ssrEnabled("Home")).toBe(true);
		expect(await r.ssrEnabled("Dashboard")).toBe(false);
	});

	it("narrows by predicate", async () => {
		const r = renderer({ pages: (c) => c.startsWith("Public/") });
		expect(await r.ssrEnabled("Public/Landing")).toBe(true);
		expect(await r.ssrEnabled("Admin/Users")).toBe(false);
	});
});

describe("photon > validation errors", () => {
	const withFlash = (bag: unknown): unknown => ({
		session: {
			flashMessages: {
				get: (path: string, fallback?: unknown) =>
					path === "inputErrorsBag" ? bag : fallback,
			},
		},
	});

	it("gives an empty bag when there is no session", () => {
		expect(getValidationErrors({})).toEqual({});
	});

	it("collapses each field to its first message", () => {
		expect(
			getValidationErrors(
				withFlash({
					email: ["Required", "Must be an email"],
					name: ["Required"],
				}),
			),
		).toEqual({ email: "Required", name: "Required" });
	});

	it("keeps every message when asked", () => {
		expect(
			getValidationErrors(withFlash({ email: ["Required", "Bad"] }), {
				allMessages: true,
			}),
		).toEqual({ email: ["Required", "Bad"] });
	});

	it("wraps a lone message into a list under allMessages", () => {
		expect(
			getValidationErrors(withFlash({ email: "Required" }), {
				allMessages: true,
			}),
		).toEqual({ email: ["Required"] });
	});
});

describe("photon > page identity", () => {
	it("carries the asset version so a stale client can be caught", async () => {
		const ctx = context();
		const out = await ctx.render("Home", { a: 1 });
		const page = JSON.parse(
			out.html.match(/<script[^>]*>({.*?})<\/script>/s)?.[1] ?? "{}",
		);
		expect(typeof page.version).toBe("string");
		expect(page.version.length).toBeGreaterThan(0);
	});

	it("advertises the shared keys, and nothing when none are shared", async () => {
		const bare = context();
		const plain = await bare.render("Home", {});
		expect(plain.html).not.toContain("sharedProps");

		const ctx = context();
		ctx.share({ user: { id: 1 }, locale: "fr" });
		const out = await ctx.render("Home", {});
		expect(out.html).toContain("sharedProps");
		expect(out.html).toContain("locale");
	});
});
