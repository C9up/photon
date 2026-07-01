/**
 * `@Meta()` — declarative SEO/head metadata on controller methods.
 *
 * Stores a `MetaResolver` (object or factory function) under the key
 * `photon:meta` via `Reflect.defineMetadata`. Mirrors the Warden
 * `@Guard / @Permission / @Role` pattern — metadata lives on the
 * **prototype** of the controller class, NOT on instances. Tests that
 * read it must pass `Class.prototype`, not `new Class()`.
 *
 * Inheritance note: `Reflect.getOwnMetadata` does NOT walk the prototype
 * chain. A subclass that inherits a decorated method without re-applying
 * `@Meta` will not see the parent's metadata. Re-decorate the override
 * (or call `super`) on subclasses that need to inherit head tags. This
 * matches Warden's `@Guard` semantics so the rule "decorators apply to
 * the exact method they annotate" is consistent across the framework.
 */

// Side-effect import: registers the `Reflect.defineMetadata`
// / `getOwnMetadata` extensions on the global Reflect API.
import "reflect-metadata";
import type { MetaTags } from "./Meta.js";

const META_KEY = "photon:meta";

export type MetaResolver<Ctx = unknown> =
	| MetaTags
	| ((ctx: Ctx) => MetaTags | undefined | Promise<MetaTags | undefined>);

/**
 * Runtime type guard: a value is `MetaTags`-shaped if it is a non-null,
 * non-array plain object. Caller is responsible for validating leaf
 * field types (TypeScript enforces statically).
 */
function isMetaTagsShape(value: unknown): value is MetaTags {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Method decorator that attaches a `MetaResolver` to the route handler.
 *
 * Usage:
 *
 *   class HomeController {
 *     @Meta({ title: 'Home', description: '...' })
 *     async index(ctx) { ... }
 *
 *     @Meta((ctx) => ({ title: `Profile — ${ctx.params.user}` }))
 *     async show(ctx) { ... }
 *   }
 */
export function Meta<Ctx = unknown>(
	resolver: MetaResolver<Ctx>,
): MethodDecorator {
	return (target, propertyKey) => {
		Reflect.defineMetadata(META_KEY, resolver, target, propertyKey);
	};
}

/**
 * Read the `@Meta` resolver attached to `target[propertyKey]`. Returns
 * `undefined` when the method has no `@Meta` decorator OR when the
 * stored value is not a recognised resolver shape (function or object).
 *
 * `target` must be the prototype (or constructor's prototype) — same
 * constraint as Warden's metadata getters.
 */
export function getRouteMeta(
	target: object,
	propertyKey: string | symbol,
): MetaResolver | undefined {
	const value: unknown = Reflect.getOwnMetadata(META_KEY, target, propertyKey);
	if (value === undefined || value === null) return undefined;
	if (typeof value === "function") {
		return value as (
			ctx: unknown,
		) => MetaTags | undefined | Promise<MetaTags | undefined>;
	}
	if (isMetaTagsShape(value)) return value;
	return undefined;
}

/**
 * Resolve a `MetaResolver` against a request context. Object form is
 * returned verbatim; function form is invoked and awaited. A function
 * resolver may legitimately return `undefined` to signal "no meta for
 * this request" — that is forwarded as `undefined`. Any other non-object
 * return value (string, number, array) is rejected at runtime and
 * surfaces as `undefined` to keep the merge layer honest.
 */
export async function resolveMeta<Ctx = unknown>(
	resolver: MetaResolver<Ctx> | undefined,
	ctx: Ctx,
): Promise<MetaTags | undefined> {
	if (!resolver) return undefined;
	if (typeof resolver === "function") {
		const result = await resolver(ctx);
		if (result === undefined || result === null) return undefined;
		return isMetaTagsShape(result) ? result : undefined;
	}
	return resolver;
}
