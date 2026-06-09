/**
 * Vue 3 adapter — uses `createSSRApp` (NOT `createApp`) to take over the
 * SSR-rendered DOM via hydration. On SPA navigation, unmount + create a fresh
 * SSR app for the new component (cleaner than reactive-props plumbing for a
 * stub router; users wanting fine-grained diffing wrap their root in a store).
 *
 * Browser-only — strict no `node:` imports.
 */

import type { PhotonAdapter, PhotonAdapterHandle } from "./types.js";

interface VueApp {
	mount(target: Element | string): unknown;
	unmount(): void;
}

interface VueModule {
	createSSRApp(
		rootComponent: unknown,
		rootProps?: Record<string, unknown> | null,
	): VueApp;
}

export const vueAdapter: PhotonAdapter = {
	async hydrate(target, Component, props): Promise<PhotonAdapterHandle> {
		// Literal import so the consumer's Vite bundles the Vue runtime.
		const vue: VueModule = await import("vue");
		let app: VueApp | undefined = vue.createSSRApp(Component, props);
		app.mount(target);

		return {
			update(NextComponent, nextProps) {
				app?.unmount();
				app = vue.createSSRApp(NextComponent, nextProps);
				app.mount(target);
			},
			unmount() {
				app?.unmount();
				app = undefined;
			},
		};
	},
};
