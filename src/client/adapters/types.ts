/**
 * Framework-adapter contract for `@c9up/photon/client`.
 *
 * Each adapter (react / vue / svelte) implements `hydrate(target, Component, props)`
 * and returns a handle the SPA-nav router uses to swap pages on navigation.
 *
 * Browser-only — strict no `node:` imports.
 */

export interface PhotonAdapterHandle {
	/**
	 * Re-render the mounted root with a new component + props. Called by the
	 * SPA-nav router.
	 *
	 * Given the component already on screen, React and Vue update its props in
	 * place and keep its state — what props arriving after the page (a deferred
	 * group, a partial reload) need. Svelte does the same through its root
	 * (`@c9up/photon/svelte`), and remounts without one.
	 */
	update(Component: unknown, props: Record<string, unknown>): void;
	/** Tear down the mounted root. Optional — currently used only by tests. */
	unmount(): void;
}

/**
 * Whether the server rendered the page into `target` — what PhotonRenderer
 * marks with `data-server-rendered`. Only such markup is hydrated; an empty
 * target is mounted, which is what a page gets when SSR is off.
 */
export function isServerRendered(target: Element): boolean {
	return target.hasAttribute("data-server-rendered");
}

export interface PhotonAdapter {
	/**
	 * Async because each adapter dynamically imports its framework runtime
	 * (`react-dom/client`, `vue`, `svelte`) on first call. Resolves AFTER the
	 * framework's hydrate primitive has run, so callers can rely on the DOM
	 * having been taken over before they fire `onHydrated`.
	 */
	hydrate(
		target: Element,
		Component: unknown,
		props: Record<string, unknown>,
		options?: AdapterOptions,
	): Promise<PhotonAdapterHandle>;
}

/** What an adapter may need beyond the page. */
export interface AdapterOptions {
	/** Svelte only: the root component from `@c9up/photon/svelte`. */
	svelteRoot?: unknown;
}
