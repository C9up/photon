/**
 * Photon — apply server-supplied `<head>` metadata to the live document.
 *
 * Mirrors the structured `MetaTags` shape that the SSR pipeline already
 * serializes to HTML via `seo/Meta.ts::serializeMetaTags`. The client side
 * cannot reuse that serializer — the SSR helper produces a string blob,
 * but here we need to mutate live DOM nodes (update `document.title`,
 * upsert `<meta>` tags by selector, replace stale ones) so that SPA
 * navigations keep `<head>` aligned with the destination page.
 *
 * Browser-only — strict no `node:` imports.
 */

import type { MetaTags } from "../seo/Meta.js";

const PHOTON_OWNED_ATTR = "data-photon-meta";

/**
 * Apply a `MetaTags` payload to `document.head`. Idempotent: re-applying
 * the same payload converges on the same DOM. Tags that this helper
 * previously inserted but are no longer in the new payload are removed,
 * so navigating from a meta-rich page to a meta-poor page does not leak
 * stale OG/Twitter tags.
 *
 * Pre-existing `<meta>`/`<link>`/`<title>` elements written by the
 * static HTML or unrelated scripts are left alone — only Photon-managed
 * nodes (marked with `data-photon-meta="1"`) are touched.
 */
/**
 * Initial `<title>` captured at module-load time so missing-title
 * navigations can restore the original instead of leaking the
 * previous page's title.
 */
const initialTitle: string =
	typeof document !== "undefined" ? document.title : "";

export function applyMetaToDom(meta: MetaTags | undefined): void {
	if (typeof document === "undefined") return;

	const head = document.head;
	if (!head) return;

	clearPhotonOwned(head);

	if (!meta) {
		// Full reset on no-meta navigation: restore the initial title so
		// the tab does not keep the previous page's value.
		document.title = initialTitle;
		return;
	}

	document.title = meta.title !== undefined ? meta.title : initialTitle;

	applyBasicMeta(head, meta);
	if (meta.og) applyOgMeta(head, meta.og);
	if (meta.twitter) applyTwitterMeta(head, meta.twitter);
	if (meta.custom) applyCustomMeta(head, meta.custom);
}

/** description / canonical / robots / keywords. */
function applyBasicMeta(head: HTMLHeadElement, meta: MetaTags): void {
	if (meta.description) {
		appendMeta(head, { name: "description", content: meta.description });
	}
	if (meta.canonical) {
		appendLink(head, { rel: "canonical", href: meta.canonical });
	}
	if (meta.robots) {
		appendMeta(head, { name: "robots", content: meta.robots });
	}
	if (meta.keywords && meta.keywords.length > 0) {
		appendMeta(head, { name: "keywords", content: meta.keywords.join(", ") });
	}
}

/** Open Graph — `property=` per spec. */
function applyOgMeta(
	head: HTMLHeadElement,
	og: NonNullable<MetaTags["og"]>,
): void {
	appendOg(head, "og:title", og.title);
	appendOg(head, "og:description", og.description);
	appendOg(head, "og:image", og.image);
	appendOg(head, "og:image:alt", og.imageAlt);
	appendOg(head, "og:url", og.url);
	appendOg(head, "og:type", og.type);
	appendOg(head, "og:site_name", og.siteName);
	appendOg(head, "og:locale", og.locale);
}

/** Twitter Cards — `name=` per spec. */
function applyTwitterMeta(
	head: HTMLHeadElement,
	tw: NonNullable<MetaTags["twitter"]>,
): void {
	appendMeta(head, { name: "twitter:card", content: tw.card });
	appendMeta(head, { name: "twitter:site", content: tw.site });
	appendMeta(head, { name: "twitter:creator", content: tw.creator });
	appendMeta(head, { name: "twitter:title", content: tw.title });
	appendMeta(head, { name: "twitter:description", content: tw.description });
	appendMeta(head, { name: "twitter:image", content: tw.image });
	appendMeta(head, { name: "twitter:image:alt", content: tw.imageAlt });
}

function applyCustomMeta(
	head: HTMLHeadElement,
	custom: NonNullable<MetaTags["custom"]>,
): void {
	for (const entry of custom) {
		const el = document.createElement("meta");
		if (entry.name) el.setAttribute("name", entry.name);
		if (entry.property) el.setAttribute("property", entry.property);
		if (entry.httpEquiv) el.setAttribute("http-equiv", entry.httpEquiv);
		if (entry.charset) el.setAttribute("charset", entry.charset);
		if (entry.content !== undefined) el.setAttribute("content", entry.content);
		el.setAttribute(PHOTON_OWNED_ATTR, "1");
		head.appendChild(el);
	}
}

function clearPhotonOwned(head: HTMLHeadElement): void {
	const owned = head.querySelectorAll(`[${PHOTON_OWNED_ATTR}]`);
	for (let i = 0; i < owned.length; i++) {
		const node = owned[i];
		if (node) node.remove();
	}
}

function appendMeta(
	head: HTMLHeadElement,
	attrs: { name?: string; content?: string },
): void {
	if (!attrs.content) return;
	const el = document.createElement("meta");
	if (attrs.name) el.setAttribute("name", attrs.name);
	el.setAttribute("content", attrs.content);
	el.setAttribute(PHOTON_OWNED_ATTR, "1");
	head.appendChild(el);
}

function appendLink(
	head: HTMLHeadElement,
	attrs: { rel: string; href: string },
): void {
	const el = document.createElement("link");
	el.setAttribute("rel", attrs.rel);
	el.setAttribute("href", attrs.href);
	el.setAttribute(PHOTON_OWNED_ATTR, "1");
	head.appendChild(el);
}

function appendOg(
	head: HTMLHeadElement,
	property: string,
	content: string | undefined,
): void {
	if (!content) return;
	const el = document.createElement("meta");
	el.setAttribute("property", property);
	el.setAttribute("content", content);
	el.setAttribute(PHOTON_OWNED_ATTR, "1");
	head.appendChild(el);
}
