/**
 * Svelte 5 adapter — uses `hydrate(Component, { target, props })` from the
 * `svelte` package. On SPA navigation, `unmount()` the previous instance then
 * `hydrate()` (or `mount()` on a cleared target) the new one.
 *
 * Note: the project standardises on Svelte 5. Svelte 4's hydration shape
 * differs (`new Component({ target, props, hydrate: true })`) — if a v4 setup
 * is encountered the dynamic-import below will resolve to v4's API and the
 * `hydrate` named export will be missing, surfacing a clear adapter-load
 * failure (caught by `loadAdapter` in `hydrate.ts`).
 *
 * Browser-only — strict no `node:` imports.
 */

import type { PhotonAdapter, PhotonAdapterHandle } from "./types.js";

type SvelteInstance = unknown;

interface SvelteModule {
	hydrate(
		Component: unknown,
		options: { target: Element; props: Record<string, unknown> },
	): SvelteInstance;
	mount(
		Component: unknown,
		options: { target: Element; props: Record<string, unknown> },
	): SvelteInstance;
	unmount(instance: SvelteInstance): void;
}

export const svelteAdapter: PhotonAdapter = {
	async hydrate(target, Component, props): Promise<PhotonAdapterHandle> {
		// Literal import so the consumer's Vite bundles the Svelte 5 runtime.
		const svelte: SvelteModule = await import("svelte");
		if (
			typeof svelte.hydrate !== "function" ||
			typeof svelte.unmount !== "function"
		) {
			// Surfaces as PHOTON_HYDRATION_ADAPTER_LOAD_FAILED in the caller.
			throw new Error(
				"svelte module is missing `hydrate` or `unmount`. Photon's Svelte adapter requires Svelte 5+.",
			);
		}

		let instance: SvelteInstance | undefined = svelte.hydrate(Component, {
			target: target as Element,
			props,
		});
		// True after `unmount()` is called explicitly — protects `update()` from
		// re-mounting a fresh instance after teardown (mirrors React adapter's
		// `if (!root) return` guard at adapters/react.ts).
		let isUnmounted = false;

		return {
			update(NextComponent, nextProps) {
				if (isUnmounted) return;
				if (instance !== undefined) {
					svelte.unmount(instance);
				}
				// `mount` (not `hydrate`) since the DOM has already been rendered once
				// by the previous client-side instance — no SSR markup to take over.
				instance = svelte.mount(NextComponent, {
					target: target as Element,
					props: nextProps,
				});
			},
			unmount() {
				if (instance !== undefined) {
					svelte.unmount(instance);
					instance = undefined;
				}
				isUnmounted = true;
			},
		};
	},
};
