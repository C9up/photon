import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
	getRouteMeta,
	Meta,
	resolveMeta,
} from "../../src/seo/MetaDecorator.js";

describe("photon > seo > @Meta decorator", () => {
	it("@Meta(obj) attaches a static MetaTags object to the method", () => {
		class HomeController {
			@Meta({ title: "Home", description: "Welcome" })
			index(): void {}
		}
		const resolver = getRouteMeta(HomeController.prototype, "index");
		expect(resolver).toEqual({ title: "Home", description: "Welcome" });
	});

	it("@Meta(fn) attaches a factory function the middleware can call", () => {
		class ProfileController {
			@Meta((ctx: { params: { user: string } }) => ({
				title: `Profile — ${ctx.params.user}`,
			}))
			show(): void {}
		}
		const resolver = getRouteMeta(ProfileController.prototype, "show");
		expect(typeof resolver).toBe("function");
	});

	it("getRouteMeta returns undefined for an un-decorated method", () => {
		class PlainController {
			naked(): void {}
		}
		expect(getRouteMeta(PlainController.prototype, "naked")).toBeUndefined();
	});

	it("metadata lives on the prototype — instances do NOT carry it", () => {
		class C {
			@Meta({ title: "X" })
			handler(): void {}
		}
		// Sanity-check the well-known constraint (matches Warden @Guard
		// behaviour): Reflect.getOwnMetadata does NOT walk to instance.
		expect(getRouteMeta(C.prototype, "handler")).toEqual({ title: "X" });
		expect(getRouteMeta(new C(), "handler")).toBeUndefined();
	});
});

describe("photon > seo > resolveMeta", () => {
	it("resolves an object resolver verbatim", async () => {
		const out = await resolveMeta({ title: "X" }, {});
		expect(out).toEqual({ title: "X" });
	});

	it("invokes a function resolver with the provided context and awaits the result", async () => {
		const out = await resolveMeta(
			(ctx: { url: string }) => ({ canonical: ctx.url }),
			{ url: "https://example.com/x" },
		);
		expect(out).toEqual({ canonical: "https://example.com/x" });
	});

	it("awaits a promise-returning function resolver", async () => {
		const out = await resolveMeta(async () => ({ title: "async" }), {});
		expect(out).toEqual({ title: "async" });
	});

	it("returns undefined when the resolver itself is undefined", async () => {
		expect(await resolveMeta(undefined, {})).toBeUndefined();
	});

	it("returns undefined when a factory legitimately returns undefined", async () => {
		const out = await resolveMeta(() => undefined, {});
		expect(out).toBeUndefined();
	});

	it("rejects a factory returning a non-object (string / number / array) at runtime", async () => {
		// Caller passes a tampered factory typed as `() => MetaTags` via JS
		// or via an `as` cast. Runtime guard must catch the bad shape and
		// surface undefined rather than corrupting the merge layer.
		const stringFactory = (() => "not-meta") as unknown as (
			ctx: unknown,
		) => import("../../src/seo/Meta.js").MetaTags;
		expect(await resolveMeta(stringFactory, {})).toBeUndefined();

		const arrayFactory = (() => ["not-meta"]) as unknown as (
			ctx: unknown,
		) => import("../../src/seo/Meta.js").MetaTags;
		expect(await resolveMeta(arrayFactory, {})).toBeUndefined();
	});

	it("getRouteMeta rejects a stored array value (typeof === 'object' but not MetaTags-shaped)", () => {
		// Hand-stuff metadata to simulate a tampered decorator call.
		class Tampered {
			handler(): void {}
		}
		Reflect.defineMetadata(
			"photon:meta",
			["not", "meta"],
			Tampered.prototype,
			"handler",
		);
		expect(getRouteMeta(Tampered.prototype, "handler")).toBeUndefined();
	});
});
