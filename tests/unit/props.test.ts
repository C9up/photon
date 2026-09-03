/**
 * Prop helpers and partial reloads — the AdonisJS Inertia semantics, which a
 * migrated controller depends on.
 */
import { describe, expect, it, vi } from "vitest";
import {
	always,
	deepMerge,
	defer,
	merge,
	once,
	optional,
	resolveProps,
	scroll,
} from "../../src/props.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}

describe("photon > props", () => {
	it("sends every prop on a normal visit", async () => {
		expect((await resolveProps({ a: 1, b: 2 }, "Users/Index")).props).toEqual({
			a: 1,
			b: 2,
		});
	});

	it("narrows to the requested props on a partial reload", async () => {
		const out = await resolveProps({ a: 1, b: 2, c: 3 }, "Users/Index", {
			only: ["b"],
			except: [],
			component: "Users/Index",
		});
		expect(out.props).toEqual({ b: 2 });
	});

	it("removes the excepted props", async () => {
		const out = await resolveProps({ a: 1, b: 2 }, "Users/Index", {
			only: [],
			except: ["a"],
			component: "Users/Index",
		});
		expect(out.props).toEqual({ b: 2 });
	});

	it("keeps an always() prop through a partial reload", async () => {
		const out = await resolveProps(
			{ a: 1, perms: always(["edit"]) },
			"Users/Index",
			{ only: ["a"], except: [], component: "Users/Index" },
		);
		expect(out.props).toEqual({ a: 1, perms: ["edit"] });
	});

	it("keeps an always() prop even when excepted by name", async () => {
		const out = await resolveProps({ perms: always(1) }, "P", {
			only: [],
			except: ["perms"],
			component: "P",
		});
		expect(out.props).toEqual({ perms: 1 });
	});

	it("never calls an optional() resolver on a normal visit", async () => {
		const resolver = vi.fn(() => "heavy");
		expect(
			(await resolveProps({ audit: optional(resolver) }, "P")).props,
		).toEqual({});
		expect(resolver).not.toHaveBeenCalled();
	});

	it("calls an optional() resolver only when named", async () => {
		const resolver = vi.fn(() => "heavy");
		const out = await resolveProps({ audit: optional(resolver) }, "P", {
			only: ["audit"],
			except: [],
			component: "P",
		});
		expect(out.props).toEqual({ audit: "heavy" });
		expect(resolver).toHaveBeenCalledOnce();
	});

	it("awaits an async optional resolver", async () => {
		const out = await resolveProps(
			{ audit: optional(async () => "later") },
			"P",
			{ only: ["audit"], except: [], component: "P" },
		);
		expect(out.props).toEqual({ audit: "later" });
	});

	it("ignores a partial reload aimed at a DIFFERENT component", async () => {
		// A half-filled page is worse than a full one: the client asked about
		// another component, so send everything.
		const out = await resolveProps({ a: 1, b: 2 }, "Posts/Index", {
			only: ["a"],
			except: [],
			component: "Users/Index",
		});
		expect(out.props).toEqual({ a: 1, b: 2 });
	});
});

describe("photon > defer", () => {
	it("announces the name and does NOT run the resolver on a normal visit", async () => {
		const resolver = vi.fn(() => "slow");
		const out = await resolveProps({ stats: defer(resolver) }, "Dash");
		expect(out.props).toEqual({});
		expect(out.extras.deferredProps).toEqual({ default: ["stats"] });
		expect(resolver).not.toHaveBeenCalled();
	});

	it("groups the names so the client fetches them together", async () => {
		const out = await resolveProps(
			{
				stats: defer(() => 1, "dashboard"),
				chart: defer(() => 2, "dashboard"),
				audit: defer(() => 3),
			},
			"Dash",
		);
		expect(out.extras.deferredProps).toEqual({
			dashboard: ["stats", "chart"],
			default: ["audit"],
		});
	});

	it("resolves on the partial reload that names it", async () => {
		const out = await resolveProps({ stats: defer(() => "slow") }, "Dash", {
			only: ["stats"],
			except: [],
			component: "Dash",
		});
		expect(out.props).toEqual({ stats: "slow" });
		expect(out.extras.deferredProps).toBeUndefined();
	});

	it("still announces a deferred prop the partial did not ask for", async () => {
		const out = await resolveProps(
			{ a: 1, stats: defer(() => "slow") },
			"Dash",
			{ only: ["a"], except: [], component: "Dash" },
		);
		expect(out.props).toEqual({ a: 1 });
		expect(out.extras.deferredProps).toEqual({ default: ["stats"] });
	});

	it("lets a rescued resolver fail without taking the reload with it", async () => {
		const out = await resolveProps(
			{
				ok: defer(() => "fine"),
				broken: defer(
					() => {
						throw new Error("upstream down");
					},
					{ rescue: true },
				),
			},
			"Dash",
			{ only: ["ok", "broken"], except: [], component: "Dash" },
		);
		expect(out.props).toEqual({ ok: "fine" });
		expect(out.extras.rescuedProps).toEqual(["broken"]);
	});

	it("lets an unrescued resolver fail loudly", async () => {
		await expect(
			resolveProps(
				{
					broken: defer(() => {
						throw new Error("upstream down");
					}),
				},
				"Dash",
				{ only: ["broken"], except: [], component: "Dash" },
			),
		).rejects.toThrow("upstream down");
	});
});

describe("photon > merge", () => {
	it("labels the prop so the client appends instead of replacing", async () => {
		const out = await resolveProps({ rows: merge([4, 5, 6]) }, "Feed");
		expect(out.props).toEqual({ rows: [4, 5, 6] });
		expect(out.extras.mergeProps).toEqual(["rows"]);
		expect(out.extras.deepMergeProps).toBeUndefined();
	});

	it("labels a deep merge separately", async () => {
		const out = await resolveProps({ settings: deepMerge({ a: 1 }) }, "S");
		expect(out.props).toEqual({ settings: { a: 1 } });
		expect(out.extras.deepMergeProps).toEqual(["settings"]);
		expect(out.extras.mergeProps).toBeUndefined();
	});

	it("chains prepend and matchOn onto the same wrapper", async () => {
		const out = await resolveProps(
			{
				feed: merge([{ id: 7 }])
					.prepend()
					.matchOn("id"),
			},
			"Feed",
		);
		expect(out.extras.prependProps).toEqual(["feed"]);
		expect(out.extras.mergeProps).toBeUndefined();
		expect(out.extras.matchPropsOn).toEqual(["feed.id"]);
	});

	it("lets append() take back a prepend()", async () => {
		const out = await resolveProps(
			{ feed: merge([1]).prepend().append() },
			"F",
		);
		expect(out.extras.mergeProps).toEqual(["feed"]);
		expect(out.extras.prependProps).toBeUndefined();
	});

	it("sends a reset prop unlabeled so the client replaces it", async () => {
		const out = await resolveProps({ rows: merge([1]) }, "Feed", {
			only: ["rows"],
			except: [],
			component: "Feed",
			reset: ["rows"],
		});
		expect(out.props).toEqual({ rows: [1] });
		expect(out.extras.mergeProps).toBeUndefined();
	});

	it("defers what it wraps and still announces the merge", async () => {
		const resolver = vi.fn(() => [1]);
		const out = await resolveProps({ rows: merge(defer(resolver)) }, "Feed");
		expect(out.props).toEqual({});
		expect(out.extras.deferredProps).toEqual({ default: ["rows"] });
		expect(out.extras.mergeProps).toEqual(["rows"]);
		expect(resolver).not.toHaveBeenCalled();
	});

	it("merges the deferred value once the partial reload asks for it", async () => {
		const out = await resolveProps({ rows: merge(defer(() => [1])) }, "Feed", {
			only: ["rows"],
			except: [],
			component: "Feed",
		});
		expect(out.props).toEqual({ rows: [1] });
		expect(out.extras.mergeProps).toEqual(["rows"]);
		expect(out.extras.deferredProps).toBeUndefined();
	});

	it("does not label a prop the partial reload left out", async () => {
		const out = await resolveProps({ a: 1, rows: merge([1]) }, "Feed", {
			only: ["a"],
			except: [],
			component: "Feed",
		});
		expect(out.props).toEqual({ a: 1 });
		expect(out.extras.mergeProps).toBeUndefined();
	});
});

describe("photon > once", () => {
	it("states the caching terms and sends the value the first time", async () => {
		const out = await resolveProps({ countries: once(["CH"]) }, "Form", {
			only: [],
			except: [],
			now: 1_000,
		});
		expect(out.props).toEqual({ countries: ["CH"] });
		expect(out.extras.onceProps).toEqual({
			countries: { prop: "countries", expiresAt: null },
		});
	});

	it("skips the resolver once the client says it holds the value", async () => {
		const resolver = vi.fn(() => ["CH"]);
		const out = await resolveProps({ countries: once(resolver) }, "Form", {
			only: [],
			except: [],
			exceptOnce: ["countries"],
		});
		expect(out.props).toEqual({});
		expect(resolver).not.toHaveBeenCalled();
		// The terms are restated so the client keeps trusting its copy.
		expect(out.extras.onceProps?.countries).toEqual({
			prop: "countries",
			expiresAt: null,
		});
	});

	it("resolves anyway when the prop forces a refresh", async () => {
		const out = await resolveProps(
			{ rates: once(() => 42, { fresh: true }) },
			"Form",
			{ only: [], except: [], exceptOnce: ["rates"] },
		);
		expect(out.props).toEqual({ rates: 42 });
	});

	it("caches under a custom key rather than the prop name", async () => {
		const resolver = vi.fn(() => 1);
		const out = await resolveProps(
			{ rates: once(resolver, { key: "fx" }) },
			"F",
			{
				only: [],
				except: [],
				exceptOnce: ["fx"],
			},
		);
		expect(out.props).toEqual({});
		expect(resolver).not.toHaveBeenCalled();
		expect(out.extras.onceProps).toEqual({
			fx: { prop: "rates", expiresAt: null },
		});
	});

	it("turns a relative duration into an absolute deadline", async () => {
		const out = await resolveProps(
			{ rates: once(1, { expiresIn: "1h" }) },
			"F",
			{ only: [], except: [], now: 5_000 },
		);
		expect(defined(out.extras.onceProps?.rates).expiresAt).toBe(
			5_000 + 3_600_000,
		);
	});

	it("reads every duration unit, and a bare number as milliseconds", async () => {
		const at = async (expiresIn: number | string): Promise<number | null> => {
			const out = await resolveProps({ v: once(1, { expiresIn }) }, "F", {
				only: [],
				except: [],
				now: 0,
			});
			return defined(out.extras.onceProps?.v).expiresAt ?? null;
		};
		expect(await at(250)).toBe(250);
		expect(await at("250ms")).toBe(250);
		expect(await at("30s")).toBe(30_000);
		expect(await at("5m")).toBe(300_000);
		expect(await at("2h")).toBe(7_200_000);
		expect(await at("7d")).toBe(604_800_000);
		expect(await at("1w")).toBe(604_800_000);
	});

	it("refuses a duration it cannot read instead of guessing", async () => {
		await expect(
			resolveProps({ v: once(1, { expiresIn: "soon" }) }, "F"),
		).rejects.toThrow(/Cannot read "soon" as a duration/);
	});

	it("lets an absolute date win over a relative one", async () => {
		const out = await resolveProps(
			{ v: once(1, { expiresIn: "1h", expiresAt: new Date(9_000) }) },
			"F",
			{ only: [], except: [], now: 0 },
		);
		expect(defined(out.extras.onceProps?.v).expiresAt).toBe(9_000);
	});

	it("composes with defer: cached terms stated, value announced", async () => {
		const out = await resolveProps(
			{
				stats: once(
					defer(() => 1),
					{ key: "stats" },
				),
			},
			"Dash",
		);
		expect(out.extras.onceProps).toEqual({
			stats: { prop: "stats", expiresAt: null },
		});
		expect(out.extras.deferredProps).toEqual({ default: ["stats"] });
	});
});

describe("photon > lazy props", () => {
	it("invokes a bare callback and sends what it returns", async () => {
		const out = await resolveProps({ total: () => 7 }, "P");
		expect(out.props).toEqual({ total: 7 });
	});

	it("awaits a promise prop", async () => {
		const out = await resolveProps({ user: Promise.resolve({ id: 1 }) }, "P");
		expect(out.props).toEqual({ user: { id: 1 } });
	});

	it("invokes a callback behind always()", async () => {
		const out = await resolveProps({ perms: always(() => ["edit"]) }, "P", {
			only: ["other"],
			except: [],
		});
		expect(out.props).toEqual({ perms: ["edit"] });
	});
});

/** The shape an atlas paginator instance presents. */
function paginator(currentPage: number, lastPage: number, rows: number[]) {
	return { data: rows, meta: { currentPage, lastPage, firstPage: 1 } };
}

describe("photon > scroll", () => {
	it("labels the data array and carries the cursor beside it", async () => {
		const out = await resolveProps(
			{ users: scroll(() => paginator(2, 5, [3, 4])) },
			"Users",
		);
		expect(out.props).toEqual({
			users: {
				data: [3, 4],
				meta: { currentPage: 2, lastPage: 5, firstPage: 1 },
			},
		});
		// The ARRAY merges; the cursor beside it is replaced each time.
		expect(out.extras.mergeProps).toEqual(["users.data"]);
		expect(out.extras.scrollProps).toEqual({
			users: {
				pageName: "page",
				currentPage: 2,
				nextPage: 3,
				previousPage: 1,
				reset: false,
			},
		});
	});

	it("stops offering a next page on the last one", async () => {
		const out = await resolveProps({ u: scroll(paginator(5, 5, [])) }, "U");
		expect(defined(out.extras.scrollProps?.u).nextPage).toBeNull();
		expect(defined(out.extras.scrollProps?.u).previousPage).toBe(4);
	});

	it("has no previous page on the first one", async () => {
		const out = await resolveProps({ u: scroll(paginator(1, 3, [])) }, "U");
		expect(defined(out.extras.scrollProps?.u).previousPage).toBeNull();
		expect(defined(out.extras.scrollProps?.u).nextPage).toBe(2);
	});

	it("keys the merge on a field so overlapping pages do not duplicate rows", async () => {
		const out = await resolveProps(
			{ users: scroll(paginator(1, 2, [])).matchOn("id") },
			"U",
		);
		expect(out.extras.matchPropsOn).toEqual(["users.data.id"]);
	});

	it("prepends when the client is scrolling the other way", async () => {
		const out = await resolveProps({ u: scroll(paginator(2, 5, [])) }, "U", {
			only: [],
			except: [],
			mergeIntent: "prepend",
		});
		expect(out.extras.prependProps).toEqual(["u.data"]);
		expect(out.extras.mergeProps).toBeUndefined();
	});

	it("drops the labels and flags a reset when the client starts over", async () => {
		const out = await resolveProps({ u: scroll(paginator(1, 5, [1])) }, "U", {
			only: ["u"],
			except: [],
			reset: ["u"],
		});
		expect(out.extras.mergeProps).toBeUndefined();
		expect(defined(out.extras.scrollProps?.u).reset).toBe(true);
		// The value still travels — a reset replaces the list, it does not empty it.
		expect(out.props.u).toEqual({
			data: [1],
			meta: { currentPage: 1, lastPage: 5, firstPage: 1 },
		});
	});

	it("holds the first page back when deferred, labels included", async () => {
		const rows = vi.fn(() => paginator(1, 5, [1]));
		const out = await resolveProps({ u: scroll(rows).deferred("feed") }, "U");
		expect(out.props).toEqual({});
		expect(rows).not.toHaveBeenCalled();
		expect(out.extras.deferredProps).toEqual({ feed: ["u"] });
		expect(out.extras.mergeProps).toEqual(["u.data"]);
		// No cursor yet: there is no page to describe.
		expect(out.extras.scrollProps).toBeUndefined();
	});

	it("resolves the deferred first page on the reload that asks for it", async () => {
		const out = await resolveProps(
			{ u: scroll(() => paginator(1, 5, [1])).deferred() },
			"U",
			{ only: ["u"], except: [], component: "U" },
		);
		expect(defined(out.extras.scrollProps?.u).currentPage).toBe(1);
		expect(out.extras.deferredProps).toBeUndefined();
	});

	it("takes a cursor callback for a source it cannot read", async () => {
		const out = await resolveProps(
			{
				feed: scroll({ data: [1], next: "abc" }, (v) => ({
					pageName: "cursor",
					currentPage: null,
					nextPage: Reflect.get(v as object, "next"),
					previousPage: null,
				})),
			},
			"F",
		);
		expect(defined(out.extras.scrollProps?.feed).nextPage).toBe("abc");
	});

	it("refuses to guess a cursor it cannot derive", async () => {
		await expect(
			resolveProps({ feed: scroll({ data: [1] }) }, "F"),
		).rejects.toThrow(/Cannot derive an infinite-scroll cursor/);
	});

	it("is left out of a partial reload that did not ask for it", async () => {
		const rows = vi.fn(() => paginator(1, 5, []));
		const out = await resolveProps({ a: 1, u: scroll(rows) }, "U", {
			only: ["a"],
			except: [],
			component: "U",
		});
		expect(out.props).toEqual({ a: 1 });
		expect(out.extras.mergeProps).toBeUndefined();
		expect(rows).not.toHaveBeenCalled();
	});
});
