/**
 * @module @c9up/photon
 * @description Photon — Frontend rendering engine for the Ream framework
 * @implements FR89, FR90, FR91, FR92, FR93
 */

export { defineConfig } from "./config.js";
export { configure } from "./configure.js";
export { PhotonError } from "./errors.js";
export type { PhotonContext } from "./PhotonContext.js";
export { createPhotonContext } from "./PhotonContext.js";
export { PhotonMiddleware } from "./PhotonMiddleware.js";
export type {
	PageProps,
	PhotonConfig,
	RenderResult,
} from "./PhotonRenderer.js";
export { PhotonRenderer } from "./PhotonRenderer.js";
// SEO / `<head>` management (Story 44.2)
export type {
	CustomMetaTag,
	MetaResolver,
	MetaTags,
	OgTags,
	TwitterTags,
} from "./seo/index.js";
export {
	getRouteMeta,
	Meta,
	mergeMeta,
	resolveMeta,
	serializeMetaTags,
} from "./seo/index.js";
