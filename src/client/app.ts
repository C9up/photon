/// <reference lib="dom" />
/**
 * Photon — what `createPhotonApp` in `@c9up/photon/react`, `/vue` and
 * `/svelte` shares, whatever the framework.
 *
 * With `createPhotonApp` the app mounts its root itself, in `setup`, as an app
 * built on `@inertiajs/*` does: `hydrateRoot(el, <App {...props} />)`. The
 * router then has no adapter to call on each visit; it calls the handle here,
 * which hands the next page to the `App` on screen. The `App` of each
 * framework connects to it once mounted, and gets any page that arrived
 * before.
 *
 * Browser-only — strict no `node:` imports.
 */

import type { PhotonAdapterHandle } from "./adapters/types.js";
import { bootPage } from "./boot.js";
import { PhotonClientError } from "./errors.js";
import type { PhotonPageData } from "./hydrate.js";

/** What the `App` of each framework is given. */
export interface PhotonAppProps {
	/** The page the server sent. */
	initialPage: PhotonPageData;
	/** Its component, resolved. */
	initialComponent: unknown;
}

/**
 * Resolves a page by name: the component, its module (its `default` export is
 * the component), or a promise of either — what `import.meta.glob` gives, lazy
 * or eager, and what `resolvePageComponent` returns.
 */
export type ResolvePage = (name: string) => unknown;

/** The page component `resolve` gives for `name`. */
export async function resolvePage(
	resolve: ResolvePage,
	name: string,
): Promise<unknown> {
	const resolved: unknown = await resolve(name);
	if (resolved === undefined || resolved === null) {
		throw new PhotonClientError(
			"E_PHOTON_UNKNOWN_PAGE",
			`resolve() found no page named '${name}'.`,
			{ hint: "Check the path your resolve() builds from the page name." },
		);
	}
	if (typeof resolved === "object" && "default" in resolved) {
		return resolved.default;
	}
	return resolved;
}

type ShowPage = (component: unknown, props: Record<string, unknown>) => void;

let show: ShowPage | undefined;
let waiting: { component: unknown; props: Record<string, unknown> } | undefined;

/** What the router updates: the `App` on screen, once it has connected. */
const appHandle: PhotonAdapterHandle = {
	update(component, props) {
		if (show !== undefined) show(component, props);
		else waiting = { component, props };
	},
	// The app owns its root, mounted in its own `setup`.
	unmount() {},
};

/**
 * Show every page the router visits through `next`, starting with one that
 * arrived before the `App` was mounted. Returns the disconnect.
 */
export function connectApp(next: ShowPage): () => void {
	show = next;
	const pending = waiting;
	waiting = undefined;
	if (pending !== undefined) next(pending.component, pending.props);
	return () => {
		if (show === next) show = undefined;
	};
}

export interface StartAppOptions {
	/** The id of the element the page is in. Default: `'app'`. */
	id?: string;
	resolve: ResolvePage;
	/** Mount the `App` into `el`. */
	mount(el: HTMLElement, props: PhotonAppProps): unknown;
}

/** In the browser: read the page, mount the app, start the router. */
export async function startApp(options: StartAppOptions): Promise<void> {
	await bootPage({
		target: `#${options.id ?? "app"}`,
		resolveComponent: async (name) => ({
			default: await resolvePage(options.resolve, name),
		}),
		mount: async (target, Component, page) => {
			if (!(target instanceof HTMLElement)) {
				throw new PhotonClientError(
					"E_PHOTON_HYDRATION_NO_TARGET",
					`#${options.id ?? "app"} is not an HTML element.`,
				);
			}
			await options.mount(target, {
				initialPage: page,
				initialComponent: Component,
			});
			return appHandle;
		},
	});
}

/** On the server: the props of the `App` that renders `page`. */
export async function appPropsFor(
	resolve: ResolvePage,
	page: PhotonPageData,
): Promise<PhotonAppProps> {
	return {
		initialPage: page,
		initialComponent: await resolvePage(resolve, page.component),
	};
}

/** What a server render of the app gives the renderer. */
export interface PhotonAppSsrResponse {
	head: string[];
	body: string;
}
