/**
 * Vue 3 adapter — uses `createSSRApp` (NOT `createApp`) to take over the
 * SSR-rendered DOM via hydration.
 *
 * The app's root is not the page but a render function that draws whichever
 * page a `shallowRef` holds. Navigation replaces the ref: a new page component
 * is swapped in by Vue itself, and the SAME component is patched with its new
 * props — its local state kept, the way props arriving after the page (a
 * deferred group, a partial reload) must be. Unmounting and creating a fresh
 * app per navigation reset every component on screen, and mounting a second
 * `createSSRApp` onto the emptied target made Vue warn about a hydration
 * mismatch on each one.
 *
 * The wrapper renders no element of its own, so the DOM it hydrates is the one
 * the page component rendered on the server.
 *
 * Browser-only — strict no `node:` imports.
 */

import type { PhotonAdapter, PhotonAdapterHandle } from "./types.js";

interface VueApp {
	mount(target: Element | string): unknown;
	unmount(): void;
}

interface VueModule {
	createSSRApp(rootComponent: { render: () => unknown }): VueApp;
	h(type: unknown, props?: Record<string, unknown> | null): unknown;
	shallowRef<T>(value: T): { value: T };
}

interface Page {
	component: unknown;
	props: Record<string, unknown>;
}

export const vueAdapter: PhotonAdapter = {
	async hydrate(target, Component, props): Promise<PhotonAdapterHandle> {
		// Literal import so the consumer's Vite bundles the Vue runtime.
		const vue: VueModule = await import("vue");
		const page = vue.shallowRef<Page>({ component: Component, props });
		let app: VueApp | undefined = vue.createSSRApp({
			render: () => vue.h(page.value.component, page.value.props),
		});
		app.mount(target);

		return {
			update(NextComponent, nextProps) {
				// Don't resurrect a torn-down component into a dead target — parity
				// with the React (`if (!root) return`) and Svelte (`if (isUnmounted)`)
				// adapters' post-unmount guard (audit 2026-06-13).
				if (app === undefined) return;
				page.value = { component: NextComponent, props: nextProps };
			},
			unmount() {
				app?.unmount();
				app = undefined;
			},
		};
	},
};
