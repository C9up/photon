import { describe, expect, it } from "vitest";
import { PhotonError } from "../../src/errors.js";
import { createPhotonContext } from "../../src/PhotonContext.js";
import {
	PhotonMiddleware,
	type PhotonMiddlewareContext,
} from "../../src/PhotonMiddleware.js";
import { PhotonRenderer } from "../../src/PhotonRenderer.js";

/** Narrow away null/undefined without a `!` non-null assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}

describe("photon > PhotonRenderer", () => {
	it("renders HTML with page data", async () => {
		const renderer = new PhotonRenderer({
			framework: "react",
			entryClient: "resources/app.tsx",
			entryServer: "resources/ssr.tsx",
		});

		const result = await renderer.render(
			"Dashboard",
			{ user: "Kaen" },
			"/dashboard",
		);
		expect(result.status).toBe(200);
		expect(result.headers["content-type"]).toContain("text/html");
		expect(result.html).toContain("<!DOCTYPE html>");
		expect(result.html).toContain('<div id="app">');
		expect(result.html).toContain("photon-data");
		expect(result.html).toContain("Dashboard");
		expect(result.headers["content-security-policy"]).toBeDefined();
	});

	it("escapes HTML entities in page data", async () => {
		const renderer = new PhotonRenderer({
			framework: "react",
			entryClient: "app.tsx",
			entryServer: "ssr.tsx",
		});

		const result = await renderer.render(
			"Page",
			{ html: "<script>alert(1)</script>" },
			"/",
		);
		// Page data uses Unicode escapes (not HTML entities) for safe JSON embedding in <script>
		expect(result.html).not.toContain("<script>alert(1)</script>");
		expect(result.html).toContain("\\u003cscript\\u003e");
	});

	it("includes Vite dev server scripts in dev mode", async () => {
		const renderer = new PhotonRenderer({
			framework: "react",
			entryClient: "resources/app.tsx",
			entryServer: "resources/ssr.tsx",
			viteDevUrl: "http://localhost:5173",
		});

		const result = await renderer.render("Home", {}, "/");
		expect(result.html).toContain("http://localhost:5173/@vite/client");
		expect(result.html).toContain("http://localhost:5173/resources/app.tsx");
		expect(result.headers["content-security-policy"]).toContain(
			"script-src 'self' http://localhost:5173",
		);
	});

	it("renderProps returns JSON for SPA navigation", () => {
		const renderer = new PhotonRenderer({
			framework: "vue",
			entryClient: "app.ts",
			entryServer: "ssr.ts",
		});

		const result = renderer.renderProps("Users", { list: [1, 2, 3] }, "/users");
		expect(result.status).toBe(200);
		expect(result.headers["content-type"]).toBe("application/json");
		expect(result.headers["x-photon"]).toBe("true");
		const data = JSON.parse(result.html);
		expect(data.component).toBe("Users");
		expect(data.props.list).toEqual([1, 2, 3]);
	});

	it("reports framework", () => {
		const renderer = new PhotonRenderer({
			framework: "svelte",
			entryClient: "app.ts",
			entryServer: "ssr.ts",
		});
		expect(renderer.getFramework()).toBe("svelte");
	});

	it("embeds the framework field in the page-data block (SSR render)", async () => {
		const renderer = new PhotonRenderer({
			framework: "react",
			entryClient: "app.tsx",
			entryServer: "ssr.tsx",
		});

		const result = await renderer.render(
			"Dashboard",
			{ user: "Kaen" },
			"/dashboard",
		);
		// Extract the photon-data JSON from the rendered HTML.
		const match = result.html.match(
			/<script type="application\/json" id="photon-data">([^<]*)<\/script>/,
		);
		expect(match).not.toBeNull();
		const data = JSON.parse(defined(defined(match)[1]));
		expect(data.framework).toBe("react");
		expect(data.component).toBe("Dashboard");
		expect(data.url).toBe("/dashboard");
	});

	it("emits the framework field in renderProps SPA-nav JSON", () => {
		const renderer = new PhotonRenderer({
			framework: "vue",
			entryClient: "app.ts",
			entryServer: "ssr.ts",
		});

		const result = renderer.renderProps("Orders", { ids: [1, 2] }, "/orders");
		const data = JSON.parse(result.html);
		expect(data.framework).toBe("vue");
		expect(data.component).toBe("Orders");
		expect(data.props.ids).toEqual([1, 2]);
	});
});

describe("photon > PhotonContext", () => {
	it("creates context bound to renderer", async () => {
		const renderer = new PhotonRenderer({
			framework: "react",
			entryClient: "app.tsx",
			entryServer: "ssr.tsx",
		});

		const ctx = createPhotonContext(renderer, "/test");
		const result = await ctx.render("TestPage", { foo: "bar" });
		expect(result.html).toContain("TestPage");
		expect(result.html).toContain("foo");
	});

	it("share() merges props into every render; per-call props win on conflict", async () => {
		const renderer = new PhotonRenderer({
			framework: "react",
			entryClient: "app.tsx",
			entryServer: "ssr.tsx",
		});
		const ctx = createPhotonContext(renderer, "/test");
		ctx.share({ sharedKey: "shared-value", overridden: "from-share" });
		ctx.share({ second: "two" }); // merges with the first share()
		const result = await ctx.render("Page", { overridden: "from-page" });
		// shared props are present on the page payload…
		expect(result.html).toContain("sharedKey");
		expect(result.html).toContain("shared-value");
		expect(result.html).toContain("second");
		// …and a per-call prop overrides a shared one of the same key.
		expect(result.html).toContain("from-page");
		expect(result.html).not.toContain("from-share");
	});
});

describe("photon > PhotonMiddleware", () => {
	it("attaches photon context to request", async () => {
		const mw = new PhotonMiddleware({
			framework: "react",
			entryClient: "app.tsx",
			entryServer: "ssr.tsx",
		});

		const ctx: PhotonMiddlewareContext = {
			request: {
				method: () => "GET",
				path: () => "/dashboard",
				header: () => undefined,
			},
		};

		const middleware = mw.middleware();
		await middleware(ctx, async () => {
			// After middleware runs, ctx.photon should be available
			expect(ctx.photon).toBeDefined();
		});
	});

	it("detects X-Photon header", async () => {
		const mw = new PhotonMiddleware({
			framework: "react",
			entryClient: "app.tsx",
			entryServer: "ssr.tsx",
		});

		const ctx: PhotonMiddlewareContext = {
			request: {
				method: () => "GET",
				path: () => "/",
				header: (name) => (name === "x-photon" ? "true" : undefined),
			},
		};

		const middleware = mw.middleware();
		await middleware(ctx, async () => {});
		// Middleware completes without error
	});

	it("returns JSON props when X-Photon is true and handler rendered HTML", async () => {
		const mw = new PhotonMiddleware({
			framework: "react",
			entryClient: "app.tsx",
			entryServer: "ssr.tsx",
		});

		// Method-based response mock matching PhotonMiddlewareContext — the
		// middleware reads/writes it through getHeader/status/header/send.
		const headers: Record<string, string> = {};
		let body = "";
		const response: PhotonMiddlewareContext["response"] = {
			status: () => response,
			header: (k, v) => {
				headers[k.toLowerCase()] = v;
				return response;
			},
			send: (b) => {
				body = b;
			},
			getHeader: (n) => headers[n.toLowerCase()],
		};
		const ctx: PhotonMiddlewareContext = {
			request: {
				method: () => "GET",
				path: () => "/users",
				header: (name) => (name === "x-photon" ? "true" : undefined),
			},
			response,
		};

		const middleware = mw.middleware();
		await middleware(ctx, async () => {
			// Handler renders SSR HTML into the response; the middleware then
			// detects X-Photon and rewrites it to a JSON props payload.
			const r = await defined(ctx.photon).render("UsersPage", { page: 2 });
			const out = defined(ctx.response);
			out.status(r.status);
			for (const [k, v] of Object.entries(r.headers)) out.header(k, v);
			out.send(r.html);
		});

		expect(headers["x-photon"]).toBe("true");
		expect(headers["content-type"]).toBe("application/json");
		const payload = JSON.parse(body);
		expect(payload.component).toBe("UsersPage");
		expect(payload.props.page).toBe(2);
		expect(payload.url).toBe("/users");
	});
});

describe("photon > PhotonError", () => {
	it("stores the fully prefixed code verbatim and sets name + message", () => {
		const err = new PhotonError("PHOTON_SSR_LOAD_FAILED", "Render failed");
		expect(err.code).toBe("PHOTON_SSR_LOAD_FAILED");
		expect(err.name).toBe("PhotonError");
		expect(err.message).toBe("Render failed");
	});
});
