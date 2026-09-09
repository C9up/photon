/**
 * Server rendering in development.
 *
 * Production loads a built SSR bundle once. There is none in dev, and loading
 * the source through Node would skip every transform the framework plugins
 * apply — so Vite's own SSR loader compiles it instead. Until this existed,
 * `render()` in dev emitted an empty shell and the client hydrated it, which
 * meant the one thing SSR is for was untestable in the environment developers
 * actually work in.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PhotonError } from "../../src/errors.js";
import {
	type PageProps,
	type PhotonConfig,
	PhotonRenderer,
	type ViteDevServerLike,
} from "../../src/PhotonRenderer.js";

const config: PhotonConfig = {
	framework: "react",
	entryClient: "resources/app.tsx",
	entryServer: "resources/ssr.tsx",
};

/** A compiler that answers with whatever module it is currently holding. */
function fakeCompiler(module: Record<string, unknown>) {
	const state = { module, loads: 0, urls: [] as string[], closed: false };
	const server: ViteDevServerLike = {
		ssrLoadModule(url) {
			state.loads += 1;
			state.urls.push(url);
			return Promise.resolve(state.module);
		},
		close() {
			state.closed = true;
			return Promise.resolve();
		},
	};
	return { server, state };
}

async function renderer(server: ViteDevServerLike): Promise<PhotonRenderer> {
	// biome-ignore lint/correctness/useHookAtTopLevel: a renderer method, not a React hook
	const instance = new PhotonRenderer(config).useDevServer(server);
	await instance.boot();
	return instance;
}

describe("photon > dev SSR", () => {
	it("renders through the compiler instead of emitting a shell", async () => {
		const { server } = fakeCompiler({
			render: (page: PageProps) => `<h1>${page.component}</h1>`,
		});
		const result = await (await renderer(server)).render("Home", {}, "/");
		expect(result.html).toContain("<h1>Home</h1>");
	});

	it("asks the compiler for the entry point, rooted", async () => {
		const { server, state } = fakeCompiler({ render: () => "" });
		await (await renderer(server)).render("Home", {}, "/");
		// Vite resolves a module by URL from the project root, so the leading
		// slash is load-bearing — a bare `resources/ssr.tsx` is looked up as a
		// bare specifier, i.e. a package name.
		expect(state.urls).toEqual(["/resources/ssr.tsx"]);
	});

	it("reloads the module on every render", async () => {
		const { server, state } = fakeCompiler({ render: () => "<p>first</p>" });
		const photon = await renderer(server);
		expect((await photon.render("Home", {}, "/")).html).toContain("first");

		// The developer edits the page. Nothing restarts.
		state.module = { render: () => "<p>second</p>" };
		expect((await photon.render("Home", {}, "/")).html).toContain("second");
		expect(state.loads).toBe(2);
	});

	it("accepts a render() hung off the default export", async () => {
		const { server } = fakeCompiler({
			default: { render: () => "<p>defaulted</p>" },
		});
		expect(
			(await (await renderer(server)).render("Home", {}, "/")).html,
		).toContain("defaulted");
	});

	it("names the entry point when it exports no render()", async () => {
		const { server } = fakeCompiler({ notRender: () => "" });
		const photon = await renderer(server);
		await expect(photon.render("Home", {}, "/")).rejects.toBeInstanceOf(
			PhotonError,
		);
	});

	it("stays client-only when the project has no SSR entry", async () => {
		// Absence is the feature being off. Starting a compiler here would cost
		// a module graph and a file watcher to produce nothing, on every project
		// that renders purely on the client.
		const root = await mkdtemp(join(tmpdir(), "photon-no-ssr-"));
		const photon = new PhotonRenderer({ ...config, appRoot: root });
		await photon.boot();
		const result = await photon.render("Home", {}, "/");
		expect(result.html).toContain('id="app"');
		expect(result.html).not.toContain("<main>");
		await photon.close();
	});

	it("releases the compiler on close", async () => {
		const { server, state } = fakeCompiler({ render: () => "" });
		const photon = await renderer(server);
		await photon.close();
		// It holds a watcher and a module graph; leaving it running keeps the
		// process alive past a shutdown signal.
		expect(state.closed).toBe(true);
		await photon.close();
		expect(state.closed).toBe(true);
	});
});
