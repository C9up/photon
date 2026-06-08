/**
 * Framework-adapter contract for `@c9up/photon/client`.
 *
 * Each adapter (react / vue / svelte) implements `hydrate(target, Component, props)`
 * and returns a handle the SPA-nav router uses to swap pages on navigation.
 *
 * Browser-only — strict no `node:` imports.
 */

export interface PhotonAdapterHandle {
	/** Re-render the mounted root with a new component + props. Called by the SPA-nav router. */
	update(Component: unknown, props: Record<string, unknown>): void;
	/** Tear down the mounted root. Optional — currently used only by tests. */
	unmount(): void;
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
	): Promise<PhotonAdapterHandle>;
}
