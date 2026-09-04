import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PhotonError } from "../../src/errors.js";
import {
	type PageProps,
	type PhotonConfig,
	PhotonRenderer,
} from "../../src/PhotonRenderer.js";

const baseConfig: PhotonConfig = {
	framework: "react",
	entryClient: "resources/app.tsx",
	entryServer: "resources/ssr.tsx",
};

describe("photon > PhotonRenderer > render() in dev mode (no SSR module)", () => {
	const orig = process.env.NODE_ENV;
	beforeEach(() => {
		process.env.NODE_ENV = "development";
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = orig;
	});

	it("returns 200 + text/html with the page-data JSON embedded as a script tag", async () => {
		const r = new PhotonRenderer(baseConfig);
		const result = await r.render("Home", { x: 1 }, "/");

		expect(result.status).toBe(200);
		expect(result.headers["content-type"]).toMatch(/text\/html/);
		expect(result.html).toContain('id="photon-data"');
		expect(result.html).toContain('"component":"Home"');
		expect(result.html).toContain('"framework":"react"');
		// Empty SSR HTML when no ssrModule.
		expect(result.html).toContain('<div id="app"></div>');
	});

	it("includes the vite dev client script in the asset list", async () => {
		const r = new PhotonRenderer({
			...baseConfig,
			viteDevUrl: "http://localhost:5173",
		});
		const result = await r.render("Home", {}, "/");
		expect(result.html).toContain("http://localhost:5173/@vite/client");
		expect(result.html).toContain("http://localhost:5173/resources/app.tsx");
	});

	it("escapes <, >, &, U+2028, U+2029 inside the page-data JSON", async () => {
		const r = new PhotonRenderer(baseConfig);
		const result = await r.render(
			"Home",
			{ html: "<script>x</script>", uni: "  " },
			"/",
		);
		// The escaped JSON must NOT contain a literal '</script>' that
		// could close the surrounding <script> block.
		const dataMatch = result.html.match(
			/id="photon-data">([\s\S]+?)<\/script>/,
		);
		const dataBlock = dataMatch?.[1] ?? "";
		expect(dataBlock).not.toContain("<script");
		expect(dataBlock).toContain("\\u003c");
		expect(dataBlock).toContain("\\u2028");
	});

	it("CSP header in dev mode includes the vite origin in script-src/connect-src", async () => {
		const r = new PhotonRenderer({
			...baseConfig,
			viteDevUrl: "http://localhost:5173",
		});
		const result = await r.render("Home", {}, "/");
		const csp = result.headers["content-security-policy"] ?? "";
		expect(csp).toContain("http://localhost:5173");
		expect(csp).toContain("ws:");
	});

	it("falls back to default vite URL when viteDevUrl is unparseable", async () => {
		const r = new PhotonRenderer({
			...baseConfig,
			// Malformed URL → getSafeOrigin returns undefined → renderer reverts to localhost.
			viteDevUrl: "not a url at all",
		});
		const result = await r.render("Home", {}, "/");
		expect(result.html).toContain("http://localhost:5173/@vite/client");
	});

	it("emits security headers x-frame-options and x-content-type-options", async () => {
		const r = new PhotonRenderer(baseConfig);
		const result = await r.render("Home", {}, "/");
		expect(result.headers["x-frame-options"]).toBe("SAMEORIGIN");
		expect(result.headers["x-content-type-options"]).toBe("nosniff");
	});
});

describe("photon > PhotonRenderer > render() in prod mode (without manifest)", () => {
	const orig = process.env.NODE_ENV;
	beforeEach(() => {
		process.env.NODE_ENV = "production";
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = orig;
	});

	it("CSP header in prod mode does NOT reference any vite origin or ws:", async () => {
		const r = new PhotonRenderer(baseConfig);
		const result = await r.render("Home", {}, "/");
		const csp = result.headers["content-security-policy"] ?? "";
		expect(csp).not.toContain("localhost:5173");
		expect(csp).not.toContain("ws:");
	});

	it("falls back to /<buildDir>/client.js when no manifest is loaded", async () => {
		const r = new PhotonRenderer({ ...baseConfig, buildDir: "public/dist" });
		const result = await r.render("Home", {}, "/");
		expect(result.html).toContain('src="/public/dist/client.js"');
	});
});

describe("photon > PhotonRenderer > render() with an SSR module", () => {
	const orig = process.env.NODE_ENV;
	beforeEach(() => {
		process.env.NODE_ENV = "development";
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = orig;
	});

	function attachSsrModule(
		r: PhotonRenderer,
		render: (page: PageProps) => string | Promise<string>,
	) {
		// Through the public seam, not a cast: the field is a real private now,
		// so the previous `as unknown as { ssrModule }` override could not reach
		// it — and never should have. `useSsrModule` is what `boot()` does after
		// loading the module from the build output.
		// biome-ignore lint/correctness/useHookAtTopLevel: a renderer method, not a React hook
		r.useSsrModule({ render });
	}

	it("calls ssrModule.render() and embeds the returned HTML inside #app", async () => {
		const r = new PhotonRenderer(baseConfig);
		attachSsrModule(r, () => "<h1>hello</h1>");
		const result = await r.render("Home", {}, "/");
		expect(result.html).toContain('<div id="app"><h1>hello</h1></div>');
	});

	it("wraps a thrown render() error into a generic SSR_RENDER_FAILED PhotonError", async () => {
		const r = new PhotonRenderer(baseConfig);
		attachSsrModule(r, () => {
			throw new Error("boom");
		});
		await expect(r.render("Home", {}, "/")).rejects.toBeInstanceOf(PhotonError);
	});

	it("rejects non-string SSR output as SSR_RENDER_FAILED", async () => {
		const r = new PhotonRenderer(baseConfig);
		attachSsrModule(r, () => 42 as unknown as string);
		await expect(r.render("Home", {}, "/")).rejects.toBeInstanceOf(PhotonError);
	});
});

describe("photon > PhotonRenderer > renderProps()", () => {
	it("returns JSON with x-photon header and framework field", () => {
		const r = new PhotonRenderer(baseConfig);
		const result = r.renderProps("Home", { user: 1 }, "/profile");
		expect(result.headers["content-type"]).toBe("application/json");
		expect(result.headers["x-photon"]).toBe("true");
		const parsed = JSON.parse(result.html);
		expect(parsed).toMatchObject({
			component: "Home",
			props: { user: 1 },
			url: "/profile",
			framework: "react",
		});
	});

	it("getFramework returns the configured framework", () => {
		expect(new PhotonRenderer(baseConfig).getFramework()).toBe("react");
		expect(
			new PhotonRenderer({ ...baseConfig, framework: "vue" }).getFramework(),
		).toBe("vue");
	});
});

describe("photon > PhotonRenderer > boot() validation", () => {
	const orig = process.env.NODE_ENV;
	let cwd: string;
	let prevCwd: string;

	beforeEach(async () => {
		process.env.NODE_ENV = "production";
		cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "photon-boot-"));
		prevCwd = process.cwd();
		process.chdir(cwd);
	});

	afterEach(async () => {
		process.chdir(prevCwd);
		await fsp.rm(cwd, { recursive: true, force: true });
		if (orig === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = orig;
	});

	it("rejects buildDir that escapes the project root via E_INVALID_CONFIG", async () => {
		const r = new PhotonRenderer({
			...baseConfig,
			buildDir: "../escape",
		});
		await expect(r.boot()).rejects.toBeInstanceOf(PhotonError);
	});

	it("rejects entryServer with path traversal", async () => {
		const r = new PhotonRenderer({
			...baseConfig,
			entryServer: "../etc/passwd",
		});
		await expect(r.boot()).rejects.toBeInstanceOf(PhotonError);
	});

	it("rejects entryClient with disallowed characters via E_INVALID_CONFIG", async () => {
		const r = new PhotonRenderer({
			...baseConfig,
			entryClient: "evil!@#$.tsx",
		});
		await expect(r.boot()).rejects.toBeInstanceOf(PhotonError);
	});

	it("throws SSR_LOAD_FAILED when the SSR bundle is absent at the expected paths", async () => {
		await fsp.mkdir(path.join(cwd, "public/build"), { recursive: true });
		const r = new PhotonRenderer(baseConfig);
		await expect(r.boot()).rejects.toBeInstanceOf(PhotonError);
	});

	it("boot() in dev mode returns immediately without filesystem checks", async () => {
		process.env.NODE_ENV = "development";
		const r = new PhotonRenderer(baseConfig);
		await expect(r.boot()).resolves.toBeUndefined();
	});
});
