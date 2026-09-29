/**
 * Route names and params typed by augmenting `PhotonRoutes`, as an app does
 * with the map `router.generateTypes()` writes. Checked by `tsc` (the test
 * typecheck includes tests); the runtime assertion only keeps vitest happy.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type { RouteName, RouteTarget } from "../../../src/client/hydrate.js";

declare module "../../../src/client/hydrate.js" {
	interface PhotonRoutes {
		home: Record<string, never>;
		"users.show": { id: string | number };
		"users.update": { id: string | number };
		"posts.index": { tag?: string };
	}
}

describe("photon/client > typed routes", () => {
	it("narrows names and params to what the application declared", () => {
		expectTypeOf<RouteName>().toEqualTypeOf<
			"home" | "users.show" | "users.update" | "posts.index"
		>();
		const ok: RouteTarget = { route: "users.show", routeParams: { id: 1 } };
		// @ts-expect-error — not a declared route
		const unknown: RouteTarget = { route: "users.nope" };
		expect([ok, unknown]).toHaveLength(2);
	});
});
