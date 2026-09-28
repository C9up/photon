import type { Component } from "svelte";

/** The page Photon's Svelte root renders. */
export interface PhotonRootProps {
	component: unknown;
	props: Record<string, unknown>;
}

/**
 * Photon's root component for Svelte 5 — pass it to `hydrate({ svelteRoot })`
 * and render it in the SSR entry, so a page keeps its state when its props
 * change.
 */
declare const PhotonRoot: Component<
	PhotonRootProps,
	{ setPage(next: PhotonRootProps): void }
>;
export default PhotonRoot;
