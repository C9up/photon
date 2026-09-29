/**
 * React adapter — uses `react-dom/client.hydrateRoot` to take over the
 * SSR-rendered DOM (`createRoot` when the server rendered nothing), then
 * re-renders via `root.render()` on SPA navigation.
 *
 * Dynamic-imports `react` and `react-dom/client` on first call so React-only
 * apps don't pay the Vue / Svelte cost (and Vue / Svelte apps don't fail at
 * load if React isn't installed).
 *
 * Browser-only — strict no `node:` imports.
 */

import {
	isServerRendered,
	type PhotonAdapter,
	type PhotonAdapterHandle,
} from "./types.js";

interface ReactRoot {
	render(node: unknown): void;
	unmount(): void;
}

interface ReactDomClientModule {
	hydrateRoot(target: Element, node: unknown): ReactRoot;
	createRoot(target: Element): ReactRoot;
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
		// Literal dynamic imports so the consumer's bundler (Vite) code-splits
		// and bundles the framework runtime. A wrapped/variable specifier (or
		// `@vite-ignore`) would leave a bare `react-dom/client` specifier the
		// browser can't resolve. Typed via the local interfaces above.
		const [reactDomClient, react]: [ReactDomClientModule, ReactModule] =
			await Promise.all([import("react-dom/client"), import("react")]);

		const element = react.createElement(Component, props);
		let root: ReactRoot | undefined;
		if (isServerRendered(target)) {
			root = reactDomClient.hydrateRoot(target, element);
		} else {
			root = reactDomClient.createRoot(target);
			root.render(element);
		}

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
