/**
 * React adapter — uses `react-dom/client.hydrateRoot` to take over the
 * SSR-rendered DOM, then re-renders via `root.render()` on SPA navigation.
 *
 * Dynamic-imports `react` and `react-dom/client` on first call so React-only
 * apps don't pay the Vue / Svelte cost (and Vue / Svelte apps don't fail at
 * load if React isn't installed).
 *
 * Browser-only — strict no `node:` imports.
 */

import { dynamicImport } from "./_dynamic-import.js";
import type { PhotonAdapter, PhotonAdapterHandle } from "./types.js";

interface ReactRoot {
	render(node: unknown): void;
	unmount(): void;
}

interface ReactDomClientModule {
	hydrateRoot(target: Element | DocumentFragment, node: unknown): ReactRoot;
}

interface ReactModule {
	createElement(
		type: unknown,
		props?: Record<string, unknown> | null,
		...children: unknown[]
	): unknown;
}

export const reactAdapter: PhotonAdapter = {
	async hydrate(target, Component, props): Promise<PhotonAdapterHandle> {
		const [reactDomClient, react] = await Promise.all([
			dynamicImport<ReactDomClientModule>("react-dom/client"),
			dynamicImport<ReactModule>("react"),
		]);

		let root: ReactRoot | undefined = reactDomClient.hydrateRoot(
			target,
			react.createElement(Component, props),
		);

		return {
			update(NextComponent, nextProps) {
				if (!root) return;
				root.render(react.createElement(NextComponent, nextProps));
			},
			unmount() {
				root?.unmount();
				root = undefined;
			},
		};
	},
};
