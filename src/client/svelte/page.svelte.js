/**
 * The page on screen for Photon's Svelte components — `usePage()`.
 *
 * A module-level `$state`, as in `@inertiajs/svelte` (`page.svelte.js`): in
 * the browser it follows the router's store; on the server `PhotonRoot` sets
 * it from its `page` prop, synchronously, before the page renders.
 */

import { getCurrentPage, subscribeToPage } from "../router.js";

const page = $state({ component: "", props: {}, url: "", framework: "svelte" });

/**
 * Make `next` the page. Fields `next` does not carry are removed, where
 * upstream's `Object.assign` would leave the previous page's `deferredProps`
 * or `rescuedProps` behind for a component to misread.
 * @param {Record<string, unknown>} next
 */
export function setPage(next) {
	for (const key of Object.keys(page)) {
		if (!(key in next)) Reflect.deleteProperty(page, key);
	}
	Object.assign(page, next);
}

/** The page on screen; its fields follow every visit. */
export function usePage() {
	return page;
}

if (typeof window !== "undefined") {
	const current = getCurrentPage();
	if (current !== undefined) setPage(current);
	subscribeToPage(setPage);
}

export default page;
