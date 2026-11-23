/**
 * The server-side errors of Photon, one class per code. A caller tests
 * `error.code` or `error instanceof errors.E_PHOTON_…`. Each carries `help`,
 * `context` and a `docsUrl` (see `photonError.ts`).
 */

import { photonErrorClass } from "./photonError.js";

/** `config/photon.ts`, or a value given to Photon, cannot be used. */
export const E_PHOTON_INVALID_CONFIG = photonErrorClass(
	"E_PHOTON_INVALID_CONFIG",
);

/** The SSR bundle could not be loaded. */
export const E_PHOTON_SSR_LOAD_FAILED = photonErrorClass(
	"E_PHOTON_SSR_LOAD_FAILED",
);

/** The SSR bundle failed to render a page. */
export const E_PHOTON_SSR_RENDER_FAILED = photonErrorClass(
	"E_PHOTON_SSR_RENDER_FAILED",
);

/** The build manifest is missing. */
export const E_PHOTON_MANIFEST_MISSING = photonErrorClass(
	"E_PHOTON_MANIFEST_MISSING",
);

/** The build manifest does not parse, or lacks an entry. */
export const E_PHOTON_MANIFEST_INVALID = photonErrorClass(
	"E_PHOTON_MANIFEST_INVALID",
);

/** `config/photon.ts` is missing. */
export const E_PHOTON_MISSING_CONFIG = photonErrorClass(
	"E_PHOTON_MISSING_CONFIG",
);

/** A duration does not parse. */
export const E_PHOTON_INVALID_DURATION = photonErrorClass(
	"E_PHOTON_INVALID_DURATION",
);

/** An infinite-scroll prop has no cursor to page from. */
export const E_PHOTON_SCROLL_CURSOR_UNDERIVABLE = photonErrorClass(
	"E_PHOTON_SCROLL_CURSOR_UNDERIVABLE",
);
