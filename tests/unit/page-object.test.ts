/**
 * `ctx.photon.page()` builds the page object `render()` would ship — same prop
 * resolution, same flags, same version — without rendering a response.
 */
import { describe, expect, it } from "vitest";
import { createPhotonContext } from "../../src/PhotonContext.js";
import type { PhotonMiddlewareContext } from "../../src/PhotonMiddleware.js";
import { PhotonRenderer } from "../../src/PhotonRenderer.js";
import { defer, merge } from "../../src/props.js";

function context(headers: Record<string, string> = {}) {
	const renderer = new PhotonRenderer({
		framework: "react",
		entryClient: "app.tsx",
		dev: true,
		assetsVersion: "v1",
	});
	const ctx: PhotonMiddlewareContext = {
		request: {
			method: () => "GET",
			path: () => "/dashboard",
			header: (name: string) => headers[name.toLowerCase()],
		},
	};
	return createPhotonContext(renderer, "/dashboard", ctx);
}

describe("photon > ctx.photon.page()", () => {
	it("returns the page object with a deferred prop announced, not resolved", async () => {
		let ran = 0;
		const photon = context();
		photon.share({ user: "ada" });
		photon.encryptHistory();
		const page = await photon.page("Dashboard", {
			at: new Date(0),
			list: merge([1]),
			stats: defer(() => {
				ran += 1;
				return 1;
			}),
		});
		expect(ran).toBe(0);
		expect(page).toEqual({
			component: "Dashboard",
			url: "/dashboard",
			framework: "react",
			version: "v1",
			// The props as the client receives them: JSON, toJSON() applied.
			props: { user: "ada", at: "1970-01-01T00:00:00.000Z", list: [1] },
			sharedProps: ["user"],
			deferredProps: { default: ["stats"] },
			mergeProps: ["list"],
			encryptHistory: true,
		});
	});

	it("is what render() ships on a props request", async () => {
		const headers = { "x-photon": "true" };
		const props = () => ({ a: 1, later: defer(() => 2) });
		const page = await context(headers).page("Dashboard", props());
		const result = await context(headers).render("Dashboard", props());
		expect(JSON.parse(result.html)).toEqual(page);
	});

	it("is what render() embeds in the HTML document", async () => {
		const props = () => ({ a: 1, later: defer(() => 2) });
		const page = await context().page("Dashboard", props());
		const result = await context().render("Dashboard", props());
		const json = /<script[^>]*id="photon-data">([^<]*)<\/script>/.exec(
			result.html,
		)?.[1];
		expect(JSON.parse(json ?? "null")).toEqual(page);
	});
});
