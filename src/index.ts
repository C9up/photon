/**
 * @module @c9up/photon
 * @description Photon — Frontend rendering engine for the Ream framework
 * @implements FR89, FR90, FR91, FR92, FR93
 */

import "./augmentations.js";

export { defineConfig } from "./config.js";
export { configure } from "./configure.js";
export * as errors from "./errors.js";
export type {
	PhotonContext,
	SharedData,
	SharedDataProvider,
} from "./PhotonContext.js";
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
	RootViewData,
	RootViewRenderer,
	SsrConfig,
	SsrRequestContext,
} from "./PhotonRenderer.js";
export { PhotonRenderer } from "./PhotonRenderer.js";
export type { PhotonError, PhotonErrorCode } from "./photonError.js";
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
	type RescuedError,
	type ResolvedProps,
	resolveProps,
	type ScrollCursor,
	type ScrollCursorProvider,
	type ScrollProp,
	type ScrollPropMeta,
	type SpecialProp,
	scroll,
} from "./props.js";
// The protocol's server half, for a renderer that writes its own document
// (aurora answers its page visits with these).
export {
	buildPageObject,
	finishVisit,
	type PageObjectOptions,
	varyOnPhoton,
} from "./protocol.js";
export {
	type PhotonRequestInfo,
	readRequestInfo,
	readRequestUrl,
	shouldReloadForAssetVersion,
} from "./requestInfo.js";
export { onRescue, type RescueListener, reportRescued } from "./rescue.js";
// SEO / `<head>` management (Story 44.2)
export type {
	CustomMetaTag,
	JsonLd,
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
