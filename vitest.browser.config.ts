import { svelte } from "@sveltejs/vite-plugin-svelte";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import type { BrowserCommand } from "vitest/node";

// Real-browser layer: what jsdom has no layout for — IntersectionObserver, the
// viewport, scroll positions — and real framework runtimes compiled the way an
// app compiles them run in actual Chromium. Point at a chromium binary via
// PHOTON_CHROMIUM locally; CI uses `playwright install`.
const executablePath = process.env.PHOTON_CHROMIUM;

/**
 * The server half of a Svelte page, rendered in Node through the test's own
 * Vite server — so the markup the browser hydrates is what an SSR entry would
 * send: `PhotonRoot` around the page.
 */
const renderSvelte: BrowserCommand<
	[page: string, props: Record<string, unknown>]
> = async (ctx, page, props) => {
	const vite = ctx.project.vite;
	const server: { render(c: unknown, o: unknown): { body: string } } =
		await vite.ssrLoadModule("svelte/server");
	const root = await vite.ssrLoadModule("/src/client/svelte/PhotonRoot.svelte");
	const component = await vite.ssrLoadModule(
		`/tests/browser/fixtures/${page}.svelte`,
	);
	return server.render(root.default, {
		props: { component: component.default, props },
	}).body;
};

export default defineConfig({
	plugins: [svelte()],
	test: {
		include: ["tests/browser/**/*.test.ts"],
		browser: {
			enabled: true,
			headless: true,
			provider: playwright({
				launch: executablePath ? { executablePath } : {},
			}),
			instances: [{ browser: "chromium" }],
			commands: { renderSvelte },
		},
	},
});
