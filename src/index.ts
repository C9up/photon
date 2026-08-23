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
export {
	getValidationErrors,
	PhotonMiddleware,
	type ValidationErrorOptions,
} from "./PhotonMiddleware.js";
export type {
	PageFlags,
	PageProps,
	PhotonConfig,
	RenderResult,
	SsrConfig,
} from "./PhotonRenderer.js";
export { PhotonRenderer } from "./PhotonRenderer.js";
export {
	type AlwaysProp,
	always,
	type DeferOptions,
	type DeferProp,
	deepMerge,
	defer,
	isAlwaysProp,
	isDeferProp,
	isMergeProp,
	isOnceProp,
	isOptionalProp,
	isScrollProp,
	type MergeProp,
	merge,
	type OnceOptions,
	type OnceProp,
	type OncePropMeta,
	type OptionalProp,
	once,
	optional,
	type PropsProtocolExtras,
	type PropsRequest,
	type ResolvedProps,
	resolveProps,
	type ScrollCursor,
	type ScrollCursorProvider,
	type ScrollProp,
	type ScrollPropMeta,
	type SpecialProp,
	scroll,
} from "./props.js";
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
