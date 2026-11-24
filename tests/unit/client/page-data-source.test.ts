/**
 * @vitest-environment jsdom
 *
 * The client boots from photon's own page-data script, never from an element
 * the page renders. Markup a sanitizer lets through keeps its `id`: a
 * `<div id="photon-data">` holding a forged page object, printed in the
 * server-rendered body or by the shell, must not stand in for the real one.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { bootPage } from "../../../src/client/boot.js";
import type { PhotonPageData } from "../../../src/client/hydrate.js";
import { createPhotonContext } from "../../../src/PhotonContext.js";
import {
	type PhotonConfig,
	PhotonRenderer,
	type RootViewData,
} from "../../../src/PhotonRenderer.js";

const forgedPage = {
	component: "Admin",
	props: { title: "forged", html: '<img src="x" onerror="alert(1)">' },
	url: "/posts/1",
	framework: "react",
	clearHistory: true,
};
const escapeText = (text: string): string =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** What a sanitizer returns unchanged: one div, an `id`, text. */
const forged = `<div id="photon-data">${escapeText(JSON.stringify(forgedPage))}</div>`;

async function renderPage(
	rootView?: PhotonConfig["rootView"],
): Promise<string> {
	const renderer = new PhotonRenderer({
		framework: "react",
		entryClient: "app.tsx",
		dev: true,
		ssr: { enabled: true },
		...(rootView === undefined ? {} : { rootView }),
	});
	// biome-ignore lint/correctness/useHookAtTopLevel: a renderer method, not a React hook
	renderer.useSsrModule({
		render: () => ({ head: [], body: `<article>${forged}</article>` }),
	});
	const photon = createPhotonContext(renderer, "/posts/1", {
		request: {
			method: () => "GET",
			path: () => "/posts/1",
			header: () => undefined,
		},
	});
	const result = await photon.render("Post", { title: "The real post" });
	return result.html;
}

/** Load `html` as the document and boot the client on it. */
async function bootFrom(html: string): Promise<PhotonPageData | undefined> {
	const parsed = new DOMParser().parseFromString(html, "text/html");
	document.head.innerHTML = parsed.head.innerHTML;
	document.body.innerHTML = parsed.body.innerHTML;
	let booted: PhotonPageData | undefined;
	await bootPage({
		resolveComponent: async (name) => ({ default: name }),
		mount: async (_target, _component, page) => {
			booted = page;
			return { update: () => {}, unmount: () => {} };
		},
	});
	return booted;
}

beforeEach(() => {
	document.head.innerHTML = "";
	document.body.innerHTML = "";
});

describe("photon > where the client reads the page object", () => {
	it("writes the page-data script before the mount element", async () => {
		const html = await renderPage();
		const script = html.indexOf(
			'<script type="application/json" id="photon-data">',
		);
		expect(script).toBeGreaterThan(-1);
		expect(script).toBeLessThan(html.indexOf('<div id="app"'));
		expect(script).toBeLessThan(html.indexOf('<div id="photon-data">'));
	});

	it("hydrates from the genuine script, not a forged element in the SSR body", async () => {
		const page = await bootFrom(await renderPage());
		expect(page?.component).toBe("Post");
		expect(page?.props).toMatchObject({ title: "The real post" });
		expect(page?.clearHistory).toBeUndefined();
	});

	it("hydrates from the genuine script when the shell prints markup before it", async () => {
		const shell = (data: RootViewData): string =>
			`<!DOCTYPE html><html><head>${data.photon.head}</head><body><header>${forged}</header>${data.photon.body}</body></html>`;
		const page = await bootFrom(await renderPage(() => shell));
		expect(page?.component).toBe("Post");
		expect(page?.props).toMatchObject({ title: "The real post" });
	});

	it("does not take a forged element for the script when the script is missing", async () => {
		document.body.innerHTML = `<div id="app"></div>${forged}`;
		await expect(
			bootPage({
				resolveComponent: async (name) => ({ default: name }),
				mount: async () => ({ update: () => {}, unmount: () => {} }),
			}),
		).rejects.toMatchObject({ code: "E_PHOTON_HYDRATION_NO_DATA" });
	});
});
