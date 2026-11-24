/**
 * The browser-side errors of Photon, one class per code, exported by
 * `@c9up/photon/client` as `errors`. Browser-only — no `node:` imports.
 */

import { photonClientErrorClass } from "./photonClientError.js";

/** The page holds no Photon page-data script. */
export const E_PHOTON_HYDRATION_NO_DATA = photonClientErrorClass(
	"E_PHOTON_HYDRATION_NO_DATA",
);

/** The page-data script does not hold a usable page object. */
export const E_PHOTON_HYDRATION_BAD_DATA = photonClientErrorClass(
	"E_PHOTON_HYDRATION_BAD_DATA",
);

/** The element to hydrate into is not in the page. */
export const E_PHOTON_HYDRATION_NO_TARGET = photonClientErrorClass(
	"E_PHOTON_HYDRATION_NO_TARGET",
);

/** The page names a framework Photon has no adapter for. */
export const E_PHOTON_HYDRATION_UNSUPPORTED_FRAMEWORK = photonClientErrorClass(
	"E_PHOTON_HYDRATION_UNSUPPORTED_FRAMEWORK",
);

/** The framework adapter could not be loaded. */
export const E_PHOTON_HYDRATION_ADAPTER_LOAD_FAILED = photonClientErrorClass(
	"E_PHOTON_HYDRATION_ADAPTER_LOAD_FAILED",
);

/** No route of the manifest has that name. */
export const E_PHOTON_UNKNOWN_ROUTE = photonClientErrorClass(
	"E_PHOTON_UNKNOWN_ROUTE",
);

/** A route was built without one of its parameters. */
export const E_PHOTON_MISSING_ROUTE_PARAMS = photonClientErrorClass(
	"E_PHOTON_MISSING_ROUTE_PARAMS",
);

/** `resolve()` found no module for a page name. */
export const E_PHOTON_UNKNOWN_PAGE = photonClientErrorClass(
	"E_PHOTON_UNKNOWN_PAGE",
);

/** A page module has no usable default export. */
export const E_PHOTON_INVALID_PAGE_MODULE = photonClientErrorClass(
	"E_PHOTON_INVALID_PAGE_MODULE",
);

/** A Photon visit was answered with something that is not a page object. */
export const E_PHOTON_INVALID_PAGE_RESPONSE = photonClientErrorClass(
	"E_PHOTON_INVALID_PAGE_RESPONSE",
);

/** A router helper ran outside a Photon app. */
export const E_PHOTON_NO_ROUTER_HOST = photonClientErrorClass(
	"E_PHOTON_NO_ROUTER_HOST",
);

/** A page helper ran before any page was mounted. */
export const E_PHOTON_NO_PAGE = photonClientErrorClass("E_PHOTON_NO_PAGE");

/** An infinite-scroll helper names a prop the page does not hold. */
export const E_PHOTON_UNKNOWN_SCROLL_PROP = photonClientErrorClass(
	"E_PHOTON_UNKNOWN_SCROLL_PROP",
);

/** A deferred-props helper was given what it cannot load. */
export const E_PHOTON_INVALID_DEFERRED = photonClientErrorClass(
	"E_PHOTON_INVALID_DEFERRED",
);

/**
 * The answer to a deferred group did not carry the props it was asked for.
 * Reported (on the `exception` router event), never thrown: the group is not
 * asked for again on this visit.
 */
export const E_PHOTON_DEFERRED_PROPS_MISSING = photonClientErrorClass(
	"E_PHOTON_DEFERRED_PROPS_MISSING",
);

/** A form helper was used without its initial data. */
export const E_PHOTON_FORM_DATA_MISSING = photonClientErrorClass(
	"E_PHOTON_FORM_DATA_MISSING",
);

/** A form store was asked for defaults it cannot hold. */
export const E_PHOTON_FORM_DEFAULTS_UNSUPPORTED = photonClientErrorClass(
	"E_PHOTON_FORM_DEFAULTS_UNSUPPORTED",
);

/** The Svelte root component is not one. */
export const E_PHOTON_INVALID_SVELTE_ROOT = photonClientErrorClass(
	"E_PHOTON_INVALID_SVELTE_ROOT",
);

/** The SSR `setup` returned what Photon cannot render. */
export const E_PHOTON_INVALID_SSR_SETUP = photonClientErrorClass(
	"E_PHOTON_INVALID_SSR_SETUP",
);
