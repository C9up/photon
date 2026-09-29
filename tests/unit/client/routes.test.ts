// @vitest-environment jsdom

/**
 * Named routes in the browser — what `Link`, `Form` and `router.visit` of
 * `@adonisjs/inertia` do with `route`, `routeParams` and `qs`, over Ream's
 * `router.namedRoutes()` / `namedManifest()` — and `resolvePageComponent`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotonClientError } from "../../../src/client/errors.js";
import { bootRouter, router } from "../../../src/client/router.js";
import {
	getRoute,
	resolvePageComponent,
	resolveTarget,
	setRoutes,
	urlFor,
} from "../../../src/client/routes.js";

beforeEach(() => {
	setRoutes({
		home: { path: "/", methods: ["GET"] },
		"users.show": { path: "/users/:id", methods: ["GET"] },
		"users.update": { path: "/users/:id", methods: ["PUT"] },
		"posts.index": { path: "/posts/:tag?", methods: ["GET"] },
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("photon/client > named routes", () => {
	it("fills and encodes params, drops an unfilled optional segment, appends qs", () => {
		expect(urlFor("users.show", { id: "a b" })).toBe("/users/a%20b");
		expect(urlFor("posts.index")).toBe("/posts");
		expect(urlFor("posts.index", { tag: "news" }, { qs: { page: 2 } })).toBe(
			"/posts/news?page=2",
		);
	});

	it("names an unknown route and a missing param", () => {
		const unknown = (): string => urlFor("nope");
		expect(unknown).toThrow(PhotonClientError);
		expect(unknown).toThrow(/Unknown route 'nope'/);
		try {
			urlFor("users.show");
		} catch (error) {
			expect(error).toBeInstanceOf(PhotonClientError);
			if (error instanceof PhotonClientError) {
				expect(error.code).toBe("E_PHOTON_MISSING_ROUTE_PARAMS");
			}
		}
	});

	it("takes the route's own method unless one is given", () => {
		expect(
			resolveTarget({ route: "users.update", routeParams: { id: 1 } }),
		).toEqual({
			url: "/users/1",
			method: "put",
		});
		expect(
			resolveTarget({
				route: "users.update",
				routeParams: { id: 1 },
				method: "patch",
			}).method,
		).toBe("patch");
		expect(resolveTarget({ href: "/x" })).toEqual({
			url: "/x",
			method: undefined,
		});
	});

	it("reads Ream's lighter namedManifest, every route a GET", () => {
		setRoutes({ about: "/about" });
		expect(getRoute("about")).toEqual({ path: "/about", methods: ["GET"] });
	});

	it("lets router.visit follow a route by name, with the route's method", async () => {
		const fetchMock = vi.fn(
			async (url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						component: "User",
						framework: "react",
						url,
						props: {},
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		bootRouter({
			target: document.body,
			adapter: { update() {}, unmount() {} },
			resolveComponent: async () => ({ default: "User" }),
			page: { component: "Home", framework: "react", url: "/", props: {} },
		});

		await router.visit(
			{ route: "users.update", routeParams: { id: 7 } },
			{
				data: { name: "Ada" },
			},
		);
		await router.post(
			{ route: "users.show", routeParams: { id: 8 } },
			{ x: 1 },
		);

		expect(fetchMock.mock.calls[0]?.[0]).toBe("/users/7");
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
		expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"name":"Ada"}');
		expect(fetchMock.mock.calls[1]?.[0]).toBe("/users/8");
		expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
	});
});

describe("photon/client > resolvePageComponent", () => {
	it("loads a lazy page, falls back through several paths, sets a layout", async () => {
		const Page = { name: "Dashboard" };
		const Layout = { name: "Layout" };
		const resolved = await resolvePageComponent(
			["Admin/Dashboard", "Dashboard"],
			{
				Dashboard: () => Promise.resolve({ default: Page }),
			},
			Layout,
		);
		expect(resolved.default).toBe(Page);
		expect(Reflect.get(Page, "layout")).toBe(Layout);
	});

	it("says which page is missing, or badly exported", async () => {
		await expect(resolvePageComponent("Nope", {})).rejects.toThrow(
			'Page not found: "Nope"',
		);
		await expect(
			resolvePageComponent("Bad", { Bad: () => Promise.resolve({}) }),
		).rejects.toThrow(/default export/);
	});
});
