/**
 * Photon — the application's named routes, in the browser.
 *
 * `Link`, `Form` and the router of `@adonisjs/inertia/react` and `/vue` take a
 * route by name — `route="users.show"`, `routeParams`, `qs` — and resolve its
 * URL and its HTTP method from Tuyau's registry. Photon's registry is Ream's
 * own: `router.namedRoutes()` (paths and methods) or `router.namedManifest()`
 * (paths only; the method is then GET), handed over once with `setRoutes`.
 *
 * One deliberate difference: Adonis passes the registry down a provider
 * (`TuyauProvider`); here it is set once for the module. The routes are the
 * application's, the same for every page and every request, so a provider in
 * each of three frameworks would carry the same object three ways.
 *
 * Names and params are typed when the app augments `PhotonRoutes` with the
 * `RouteParams` map `router.generateTypes()` writes:
 *
 * ```ts
 * import type { RouteParams } from './routes.d.ts'
 * declare module '@c9up/photon/client' {
 *   interface PhotonRoutes extends RouteParams {}
 * }
 * ```
 *
 * `PhotonRoutes` is declared in the client entry itself (`hydrate.ts`): a
 * module augmentation only reaches the module that declares an interface, not
 * one that re-exports it.
 *
 * Browser-only — strict no `node:` imports.
 */

import { PhotonClientError } from "./errors.js";
import type { PhotonRoutes } from "./hydrate.js";
import type { Method } from "./router.js";

/** A route name: one of `PhotonRoutes` once typed, any string until then. */
export type RouteName = keyof PhotonRoutes extends never
	? string
	: Extract<keyof PhotonRoutes, string>;

/** The params `name` takes. */
export type RouteParamsFor<N extends string> = N extends keyof PhotonRoutes
	? PhotonRoutes[N]
	: Record<string, string | number>;

/** What `setRoutes` takes: `namedRoutes()` or `namedManifest()` from Ream. */
export type RouteManifest = Record<
	string,
	string | { path: string; methods: string[] }
>;

/** Where a visit goes: a named route, or a plain `href`. */
export type RouteTarget<N extends RouteName = RouteName> =
	| {
			route: N;
			routeParams?: RouteParamsFor<N>;
			/** Query parameters appended to the route's URL. */
			qs?: Record<string, string | number | boolean>;
			/** Default: the route's first method. */
			method?: Method;
	  }
	| { href: string; method?: Method };

let registry: Record<string, { path: string; methods: string[] }> = {};

/** Hand the application's named routes to the browser. */
export function setRoutes(routes: RouteManifest): void {
	registry = Object.fromEntries(
		Object.entries(routes).map(([name, route]) => [
			name,
			typeof route === "string" ? { path: route, methods: ["GET"] } : route,
		]),
	);
}

/** A named route's path pattern and methods; throws for an unknown name. */
export function getRoute(name: string): { path: string; methods: string[] } {
	const route = registry[name];
	if (route === undefined) {
		const known = Object.keys(registry);
		throw new PhotonClientError(
			"E_PHOTON_UNKNOWN_ROUTE",
			`Unknown route '${name}'.`,
			{
				hint:
					known.length > 0
						? `Known routes: ${known.join(", ")}.`
						: "No routes are registered — call setRoutes(router.namedRoutes()) first.",
			},
		);
	}
	return route;
}

/**
 * The URL of a named route: `:param` placeholders filled and encoded, unfilled
 * optional (`:name?`) segments dropped, `qs` appended — Ream's `router.urlFor`,
 * in the browser. A missing required param throws rather than leaving `:id` in
 * a URL the server would read as a literal.
 */
export function urlFor(
	name: string,
	params: Record<string, string | number> = {},
	options: { qs?: Record<string, string | number | boolean> } = {},
): string {
	let url = getRoute(name).path;
	for (const [key, value] of Object.entries(params)) {
		const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		url = url.replace(
			new RegExp(`:${escaped}\\??(?![\\w])`, "g"),
			encodeURIComponent(String(value)),
		);
	}
	url = url.replace(/\/:[A-Za-z_]\w*\?/g, "");
	const missing = url.match(/:[A-Za-z_]\w*/g);
	if (missing) {
		throw new PhotonClientError(
			"E_PHOTON_MISSING_ROUTE_PARAMS",
			`Route '${name}' needs ${missing.join(", ")}.`,
			{ context: { route: name, params } },
		);
	}
	const query = new URLSearchParams(
		Object.entries(options.qs ?? {}).map(([key, value]) => [
			key,
			String(value),
		]),
	).toString();
	return query === "" ? url : `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

/**
 * The URL and method a target resolves to: a named route's URL and (unless
 * `method` is given) its first method, or an `href` as it is.
 */
export function resolveTarget(target: RouteTarget): {
	url: string;
	method: Method | undefined;
} {
	if ("href" in target) return { url: target.href, method: target.method };
	const params: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(target.routeParams ?? {})) {
		if (typeof value === "string" || typeof value === "number")
			params[key] = value;
	}
	const url = urlFor(target.route, params, { qs: target.qs });
	const first = getRoute(target.route).methods[0]?.toLowerCase();
	return { url, method: target.method ?? toMethod(first) };
}

/** How `Link` and `Form` name where they go — Adonis's route props, or a URL. */
export interface RouteProps {
	href?: string;
	route?: RouteName;
	routeParams?: Record<string, string | number>;
	qs?: Record<string, string | number | boolean>;
	method?: Method;
}

/**
 * The URL and method of a `Link` / `Form`: its named route when it has one —
 * the route's first method unless `method` is given, as in
 * `@adonisjs/inertia` — else its `href` with `method` or GET.
 */
export function resolveRouteProps(
	props: RouteProps,
	fallbackUrl = "",
): { url: string; method: Method } {
	if (props.route !== undefined) {
		const resolved = resolveTarget({
			route: props.route,
			routeParams: props.routeParams,
			qs: props.qs,
			method: props.method,
		});
		return { url: resolved.url, method: resolved.method ?? "get" };
	}
	return { url: props.href ?? fallbackUrl, method: props.method ?? "get" };
}

function toMethod(value: string | undefined): Method | undefined {
	switch (value) {
		case "get":
		case "post":
		case "put":
		case "patch":
		case "delete":
			return value;
		default:
			return value === "head" ? "get" : undefined;
	}
}

/**
 * The page component registered under `path` — or the first of several
 * paths that is — loaded if it is lazy; `layout` is set on it unless it has
 * one. `resolvePageComponent` from `@adonisjs/inertia/helpers`, unchanged.
 */
export async function resolvePageComponent<T>(
	path: string | string[],
	pages: Record<string, Promise<T> | (() => Promise<T>) | T>,
	layout?: unknown,
): Promise<T> {
	for (const candidate of Array.isArray(path) ? path : [path]) {
		const page = pages[candidate];
		if (page === undefined) continue;
		const resolved = await (isLoader(page) ? page() : page);
		const loaded: unknown = resolved;
		if (
			typeof loaded !== "object" ||
			loaded === null ||
			!("default" in loaded)
		) {
			throw new Error(
				`Invalid page exported from "${String(path)}". Make sure to default export a function`,
			);
		}
		const component: unknown = loaded.default;
		if (
			layout !== undefined &&
			(typeof component === "object" || typeof component === "function") &&
			component !== null &&
			!Reflect.get(component, "layout")
		) {
			Reflect.set(component, "layout", layout);
		}
		return resolved;
	}
	throw new Error(`Page not found: "${String(path)}"`);
}

/** A lazy page entry — `() => import(...)` — rather than the module itself. */
function isLoader<T>(
	entry: Promise<T> | (() => Promise<T>) | T,
): entry is () => Promise<T> {
	return typeof entry === "function";
}
