/**
 * Photon SEO — `<head>` tag types, serialization, and merging.
 *
 * Pure HTML producers — no DOM, no framework runtime. Safe to call from
 * SSR, from route handlers, or from tests.
 */

export interface OgTags {
	title?: string;
	description?: string;
	image?: string;
	imageAlt?: string;
	url?: string;
	type?: string;
	siteName?: string;
	locale?: string;
}

export interface TwitterTags {
	card?: "summary" | "summary_large_image" | "app" | "player";
	site?: string;
	creator?: string;
	title?: string;
	description?: string;
	image?: string;
	imageAlt?: string;
}

export interface CustomMetaTag {
	name?: string;
	property?: string;
	httpEquiv?: string;
	charset?: string;
	content?: string;
}

export interface MetaTags {
	title?: string;
	description?: string;
	canonical?: string;
	robots?: string;
	keywords?: string[];
	og?: OgTags;
	twitter?: TwitterTags;
	custom?: CustomMetaTag[];
}

/**
 * Escape a string for safe embedding inside an HTML attribute value or
 * inside `<title>...</title>`. Conservative: escapes `&`, `<`, `>`, `"`, `'`.
 *
 * Why also `'`: the renderer uses double quotes for attribute values, so a
 * lone `'` is safe in attributes — but `<title>` content is parsed as HTML
 * text and a `'` is benign there too. Escaping it costs nothing and
 * removes a class of "what if an attribute uses single quotes" bugs.
 */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function metaTag(attrs: Record<string, string | undefined>): string | null {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined || value === null || value === "") continue;
		parts.push(`${key}="${escapeHtml(value)}"`);
	}
	if (parts.length === 0) return null;
	return `<meta ${parts.join(" ")}>`;
}

/**
 * Serialize a `MetaTags` block into HTML lines for injection inside
 * `<head>`. Returns an empty string when no field is set.
 */
export function serializeMetaTags(meta: MetaTags | undefined): string {
	if (!meta) return "";
	const lines: string[] = [
		...basicMetaTags(meta),
		...(meta.og ? openGraphTags(meta.og) : []),
		...(meta.twitter ? twitterTags(meta.twitter) : []),
		...(meta.custom ? customMetaTags(meta.custom) : []),
	];
	return lines.join("\n  ");
}

function pushTag(out: string[], tag: string | null): void {
	if (tag) out.push(tag);
}

/** title / description / canonical / robots / keywords. */
function basicMetaTags(meta: MetaTags): string[] {
	const out: string[] = [];
	if (meta.title) out.push(`<title>${escapeHtml(meta.title)}</title>`);
	if (meta.description) {
		pushTag(out, metaTag({ name: "description", content: meta.description }));
	}
	if (meta.canonical) {
		out.push(`<link rel="canonical" href="${escapeHtml(meta.canonical)}">`);
	}
	if (meta.robots)
		pushTag(out, metaTag({ name: "robots", content: meta.robots }));
	if (meta.keywords && meta.keywords.length > 0) {
		pushTag(
			out,
			metaTag({ name: "keywords", content: meta.keywords.join(", ") }),
		);
	}
	return out;
}

/** Emit `<meta>` tags from `[key, value]` pairs, skipping empty values. */
function pairMetaTags(
	pairs: Array<[string, string | undefined]>,
	kind: "property" | "name",
): string[] {
	const out: string[] = [];
	for (const [key, content] of pairs) {
		if (!content) continue;
		pushTag(
			out,
			kind === "property"
				? metaTag({ property: key, content })
				: metaTag({ name: key, content }),
		);
	}
	return out;
}

/** Open Graph — `property=` per spec. */
function openGraphTags(og: NonNullable<MetaTags["og"]>): string[] {
	return pairMetaTags(
		[
			["og:title", og.title],
			["og:description", og.description],
			["og:image", og.image],
			["og:image:alt", og.imageAlt],
			["og:url", og.url],
			["og:type", og.type],
			["og:site_name", og.siteName],
			["og:locale", og.locale],
		],
		"property",
	);
}

/** Twitter Cards — `name=` per spec (NOT property). */
function twitterTags(tw: NonNullable<MetaTags["twitter"]>): string[] {
	return pairMetaTags(
		[
			["twitter:card", tw.card],
			["twitter:site", tw.site],
			["twitter:creator", tw.creator],
			["twitter:title", tw.title],
			["twitter:description", tw.description],
			["twitter:image", tw.image],
			["twitter:image:alt", tw.imageAlt],
		],
		"name",
	);
}

function customMetaTags(custom: NonNullable<MetaTags["custom"]>): string[] {
	const out: string[] = [];
	for (const entry of custom) {
		pushTag(
			out,
			metaTag({
				name: entry.name,
				property: entry.property,
				"http-equiv": entry.httpEquiv,
				charset: entry.charset,
				content: entry.content,
			}),
		);
	}
	return out;
}

/**
 * Merge layers of `MetaTags` — last wins per leaf field. Sub-objects
 * (`og`, `twitter`) are merged field-by-field, NOT object-replaced.
 *
 * Arrays:
 *   - `keywords`: concat then de-dup (case-insensitive).
 *   - `custom`: concat then de-dup by `name||property||httpEquiv||charset`.
 */
export function mergeMeta(...layers: Array<MetaTags | undefined>): MetaTags {
	const out: MetaTags = {};

	for (const layer of layers) {
		if (!layer) continue;
		// Empty strings are treated as "no value" for scalar leaves —
		// they would be dropped by `serializeMetaTags` anyway, so taking
		// them at merge time would silently clobber a real value from an
		// earlier layer. Callers who genuinely want to clear a tag
		// should wrap their flow OR omit the field, not pass `""`.
		if (layer.title) out.title = layer.title;
		if (layer.description) out.description = layer.description;
		if (layer.canonical) out.canonical = layer.canonical;
		if (layer.robots) out.robots = layer.robots;
		if (layer.keywords) {
			out.keywords = dedupeKeywords([
				...(out.keywords ?? []),
				...layer.keywords,
			]);
		}
		if (layer.og) out.og = { ...(out.og ?? {}), ...layer.og };
		if (layer.twitter) {
			out.twitter = { ...(out.twitter ?? {}), ...layer.twitter };
		}
		if (layer.custom) {
			out.custom = dedupeCustom([...(out.custom ?? []), ...layer.custom]);
		}
	}

	return out;
}

function dedupeKeywords(words: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const w of words) {
		const key = w.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(w);
	}
	return out;
}

function dedupeCustom(entries: CustomMetaTag[]): CustomMetaTag[] {
	const seen = new Map<string, CustomMetaTag>();
	for (const entry of entries) {
		const key =
			entry.name ?? entry.property ?? entry.httpEquiv ?? entry.charset ?? "";
		if (key === "") continue; // skip entries with no identifying attribute
		seen.set(key, entry); // last wins
	}
	return [...seen.values()];
}
