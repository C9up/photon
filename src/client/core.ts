/**
 * `@c9up/photon/client/core` — the client router without photon's bundled
 * adapters: for an application that brings its own (aurora's, an app on a
 * phone), so a bundler that follows every `import()` (Metro) does not pull
 * React, Vue or Svelte in. `@c9up/photon/client` is this plus `hydrate()`.
 */

export type { PhotonAdapterHandle } from "./adapters/types.js";
export { type BootPageOptions, bootPage } from "./boot.js";
export type { PhotonClientErrorCode } from "./errors.js";
export { PhotonClientError } from "./errors.js";
export { browserHost, type PhotonEvent, type PhotonHost } from "./host.js";
export type { PhotonPageData } from "./hydrate.js";
export type {
	PartialRequest,
	ResolveComponent,
	RouterEvents,
	VisitCallbacks,
	VisitOptions,
} from "./router.js";
export { router } from "./router.js";
export {
	getRoute,
	type RouteManifest,
	type RouteName,
	type RouteParamsFor,
	type RouteTarget,
	setRoutes,
	urlFor,
} from "./routes.js";
