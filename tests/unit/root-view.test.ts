/**
 * The HTML shell belongs to the application: `rootView` names a template the
 * host's view engine renders (`ctx.view.render(name, data)`), or — for a host
 * with no engine — resolves per request to a function that writes the shell.
 * Either way it receives the page object, the SSR output, photon's markup and
 * the caller's view props.
 */
import { describe, expect, it } from "vitest";
import { createPhotonContext } from "../../src/PhotonContext.js";
import type { PhotonMiddlewareContext } from "../../src/PhotonMiddleware.js";
import {
	type PhotonConfig,
	PhotonRenderer,
	type RootViewData,
} from "../../src/PhotonRenderer.js";

type ViewCtx = PhotonMiddlewareContext & {
	locale?: string;
	view?: { render(name: string, data: unknown): Promise<string> };
};

function setup(
	rootView: PhotonConfig["rootView"],
	extra: Partial<ViewCtx> = {},
	ssr = false,
) {
	const renderer = new PhotonRenderer({
		framework: "react",
		entryClient: "app.tsx",
		dev: true,
		rootView,
		...(ssr ? { ssr: { enabled: true } } : {}),
	});
	// Installed either way: without `ssr.enabled` it is never called.
	// biome-ignore lint/correctness/useHookAtTopLevel: a renderer method, not a React hook
	renderer.useSsrModule({
		render: () => ({
			head: ["<title>ssr</title>"],
			body: "<main>ssr</main>",
		}),
	});
	const ctx: ViewCtx = {
		request: {
			method: () => "GET",
			path: () => "/",
			header: () => undefined,
		},
		...extra,
	};
	return createPhotonContext(renderer, "/", ctx);
}

const shell = (data: RootViewData): string =>
	`<!DOCTYPE html><html lang="${String(data.lang)}"><head>${data.photon.head}</head><body class="${String(data.theme)}">${data.photon.body}</body></html>`;

describe("photon > rootView", () => {
	it("keeps the built-in shell when none is configured", async () => {
		const result = await setup(undefined).render("Home", {});
		expect(result.html).toMatch(/^<!DOCTYPE html>\n<html>\n<head>/);
		expect(result.html).toContain('<div id="app">');
	});

	for (const ssr of [false, true]) {
		it(`a function rootView resolved per request writes the shell (SSR ${ssr ? "on" : "off"})`, async () => {
			const seen: RootViewData[] = [];
			const photon = setup(
				(ctx) => {
					const locale = Reflect.get(Object(ctx), "locale");
					return (data) => {
						seen.push(data);
						return shell({ ...data, lang: locale });
					};
				},
				{ locale: "fr" },
				ssr,
			);
			const result = await photon.render("Home", { a: 1 }, undefined, {
				theme: "dark",
			});
			expect(result.html).toContain('<html lang="fr">');
			expect(result.html).toContain('<body class="dark">');
			expect(result.html).toContain(
				'<script type="application/json" id="photon-data">',
			);
			expect(seen[0]?.page).toMatchObject({
				component: "Home",
				props: { a: 1 },
			});
			if (ssr) {
				expect(seen[0]?.page.ssrBody).toBe("<main>ssr</main>");
				expect(seen[0]?.page.ssrHead).toEqual(["<title>ssr</title>"]);
				expect(result.html).toContain(
					'<div id="app" data-server-rendered="true"><main>ssr</main></div>',
				);
				expect(result.html).toContain("<title>ssr</title>");
			} else {
				expect(seen[0]?.page.ssrBody).toBeUndefined();
			}
		});
	}

	it("a template name renders through the host's view engine with the view props", async () => {
		const calls: { name: string; data: unknown }[] = [];
		const photon = setup(
			(ctx) => `layouts/${String(Reflect.get(Object(ctx), "locale"))}`,
			{
				locale: "fr",
				view: {
					render: async (name, data) => {
						calls.push({ name, data });
						return '<html lang="fr"></html>';
					},
				},
			},
		);
		const result = await photon.render("Home", { a: 1 }, undefined, {
			title: "x",
		});
		expect(result.html).toBe('<html lang="fr"></html>');
		expect(calls[0]?.name).toBe("layouts/fr");
		expect(calls[0]?.data).toMatchObject({
			title: "x",
			page: { component: "Home", props: { a: 1 } },
		});
	});

	it("refuses a template name on a host with no view engine", async () => {
		await expect(setup("app").render("Home", {})).rejects.toMatchObject({
			code: "E_PHOTON_INVALID_CONFIG",
		});
	});
});
