/**
 * `createPhotonApp` for Svelte 5 — the shape of `createInertiaApp` in
 * `@inertiajs/svelte` 3.7.1, with `PhotonRoot` as the `App`.
 *
 * In the browser it reads the page the server sent, hydrates `PhotonRoot`
 * when the server rendered the page (mounts it otherwise, or hands it to
 * `setup`), and starts the router. On the server, given `page`, `setup` must
 * return `render(App, { props })` from `svelte/server`, as upstream requires:
 * importing the server renderer here would put it in every client bundle.
 */

import { hydrate, mount } from "svelte";
import { isServerRendered } from "../adapters/types.js";
import { appPropsFor, startApp } from "../app.js";
import PhotonRoot from "./PhotonRoot.svelte";

/**
 * @param {{
 *   id?: string;
 *   resolve: (name: string) => unknown;
 *   setup?: (options: { el: HTMLElement | null; App: unknown; props: Record<string, unknown> }) => unknown;
 *   page?: import("../hydrate.js").PhotonPageData;
 * }} options
 */
export async function createPhotonApp({ id, resolve, setup, page }) {
	if (page !== undefined) {
		if (setup === undefined) {
			throw new TypeError(
				"createPhotonApp needs a setup on the server that returns render(App, { props }) from svelte/server.",
			);
		}
		const { initialComponent } = await appPropsFor(resolve, page);
		const result = await setup({
			el: null,
			App: PhotonRoot,
			props: { component: initialComponent, props: page.props, page },
		});
		const body = Reflect.get(Object(result), "body");
		const head = Reflect.get(Object(result), "head");
		if (typeof body !== "string") {
			throw new TypeError(
				"createPhotonApp's setup must return render(App, { props }) from svelte/server on the server.",
			);
		}
		return {
			head: typeof head === "string" && head !== "" ? [head] : [],
			body,
		};
	}
	await startApp({
		id,
		resolve,
		mount: async (el, { initialPage, initialComponent }) => {
			const props = { component: initialComponent, props: initialPage.props };
			if (setup !== undefined) return setup({ el, App: PhotonRoot, props });
			const start = isServerRendered(el) ? hydrate : mount;
			start(PhotonRoot, { target: el, props });
		},
	});
}
