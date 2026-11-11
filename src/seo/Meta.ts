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

/**
 * Structured data for the page, as JSON-LD: one node, several, or a whole
 * `{ "@context", "@graph" }` document — what `@c9up/ephemeris` builds
 * (`SchemaGraph#toJsonLd()`, its helpers), or any plain object of the shape.
 * Photon depends on the shape only, never on a package.
 */
export type JsonLd = object | readonly object[];

export interface MetaTags {
	title?: string;
	description?: string;
	canonical?: string;
	robots?: string;
	keywords?: string[];
	og?: OgTags;
	twitter?: TwitterTags;
	custom?: CustomMetaTag[];
	jsonLd?: JsonLd;
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

/**
 * The attribute that marks a tag as Photon's, so the client router replaces it
 * on navigation. Must match `PHOTON_OWNED_ATTR` in `client/applyMeta.ts`, which
 * cannot import it — the browser bundle stays free of this module's callers.
 *
 * The tags rendered on the server carry it too. Without it the first SPA
 * navigation left them in place and added its own beside them: two canonicals,
 * two descriptions, two sets of Open Graph tags.
 */
const OWNED = 'data-photon-meta="1"';

function metaTag(attrs: Record<string, string | undefined>): string | null {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined || value === null || value === "") continue;
		parts.push(`${key}="${escapeHtml(value)}"`);
	}
	if (parts.length === 0) return null;
	return `<meta ${parts.join(" ")} ${OWNED}>`;
}

/**
 * Serialize a `MetaTags` block into HTML lines for injection inside
 * `<head>`. Returns an empty string when no field is set. The request's CSP
 * nonce, when there is one, goes on the JSON-LD script.
 */
export function serializeMetaTags(
	meta: MetaTags | undefined,
	options: { nonce?: string } = {},
): string {
	if (!meta) return "";
	const jsonLd = jsonLdText(meta.jsonLd);
	const nonce =
		options.nonce === undefined || options.nonce === ""
			? ""
			: ` nonce="${escapeHtml(options.nonce)}"`;
	const lines: string[] = [
		...basicMetaTags(meta),
		...(meta.og ? openGraphTags(meta.og) : []),
		...(meta.twitter ? twitterTags(meta.twitter) : []),
		...(meta.custom ? customMetaTags(meta.custom) : []),
		...(jsonLd === undefined
			? []
			: [
					`<script type="application/ld+json"${nonce} ${OWNED}>${jsonLd}</script>`,
				]),
	];
	return lines.join("\n  ");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** The nodes of a JSON-LD value: a document's `@graph`, a list, or one node. */
function jsonLdNodes(value: JsonLd | undefined): Record<string, unknown>[] {
	if (value === undefined) return [];
	return [value].flat().flatMap((entry: unknown) => {
		if (!isPlainObject(entry)) return [];
		const graph = entry["@graph"];
		if (Array.isArray(graph)) {
			return graph.filter(isPlainObject);
		}
		// The document gets one context; a node keeps none of its own.
		return [
			Object.fromEntries(
				Object.entries(entry).filter(([key]) => key !== "@context"),
			),
		];
	});
}

/**
 * The JSON-LD text for the page, or `undefined` when there is none: one
 * document, `@graph` when there are several nodes. `<`, `>`, `&`, U+2028 and
 * U+2029 are written as `\u` escapes, so no value can end the script.
 */
export function jsonLdText(value: JsonLd | undefined): string | undefined {
	const nodes = jsonLdNodes(value);
	if (nodes.length === 0) return undefined;
	const document =
		nodes.length === 1
			? { "@context": "https://schema.org", ...nodes[0] }
			: { "@context": "https://schema.org", "@graph": nodes };
	return JSON.stringify(document).replace(
		/[<>&\u2028\u2029]/g,
		(character) =>
			`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

/**
 * Two layers' structured data as one: nodes with the same `@id` merge — the
 * types united, what the later layer sets wins — and the rest follow in order.
 */
function mergeJsonLd(
	earlier: JsonLd | undefined,
	later: JsonLd | undefined,
): Record<string, unknown>[] {
	// Where each `@id` sits in `out`, so a later node replaces its slot.
	const slotById = new Map<string, number>();
	const out: Record<string, unknown>[] = [];
	for (const node of [...jsonLdNodes(earlier), ...jsonLdNodes(later)]) {
		const id = node["@id"];
		if (typeof id !== "string") {
			out.push(node);
			continue;
		}
		const slot = slotById.get(id);
		const existing = slot === undefined ? undefined : out[slot];
		if (slot === undefined || existing === undefined) {
			slotById.set(id, out.length);
			out.push({ ...node });
			continue;
		}
		const types = [
			...new Set(
				[existing["@type"], node["@type"]]
					.flat()
					.filter((type) => typeof type === "string"),
			),
		];
		// Built from entries, not `Object.assign`: a parsed node can carry an
		// OWN `__proto__` key, and assigning it re-parented the merged node.
		const merged = Object.fromEntries([
			...Object.entries(existing),
			...Object.entries(node),
		]);
		if (types.length > 0)
			merged["@type"] = types.length === 1 ? types[0] : types;
		out[slot] = merged;
	}
	return out;
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
		out.push(
			`<link rel="canonical" href="${escapeHtml(meta.canonical)}" ${OWNED}>`,
		);
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
		if (layer.jsonLd) out.jsonLd = mergeJsonLd(out.jsonLd, layer.jsonLd);
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

const META_STRING_FIELDS = [
	"title",
	"description",
	"canonical",
	"robots",
] as const;
const OG_FIELDS = [
	"title",
	"description",
	"image",
	"imageAlt",
	"url",
	"type",
	"siteName",
	"locale",
] as const;
const TWITTER_STRING_FIELDS = [
	"site",
	"creator",
	"title",
	"description",
	"image",
	"imageAlt",
] as const;
const TWITTER_CARDS = [
	"summary",
	"summary_large_image",
	"app",
	"player",
] as const;
const CUSTOM_FIELDS = [
	"name",
	"property",
	"httpEquiv",
	"charset",
	"content",
] as const;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTwitterCard(value: unknown): value is TwitterTags["card"] {
	return TWITTER_CARDS.some((card) => card === value);
}

/** The string fields of `source` named in `fields`; anything else dropped. */
function pickStrings<K extends string>(
	source: Record<string, unknown>,
	fields: readonly K[],
): Partial<Record<K, string>> {
	const out: Partial<Record<K, string>> = {};
	for (const field of fields) {
		const value = source[field];
		if (typeof value === "string") out[field] = value;
	}
	return out;
}

/**
 * Read `MetaTags` out of a payload the client received: each field kept only
 * when it has the type the head code relies on, so a malformed payload
 * cannot make it call `join` on a string or set an attribute to an object.
 */
export function readMetaTags(value: unknown): MetaTags | undefined {
	if (!isObjectRecord(value)) return undefined;
	const meta: MetaTags = pickStrings(value, META_STRING_FIELDS);
	const { keywords, og, twitter, custom, jsonLd } = value;
	if (Array.isArray(keywords)) {
		meta.keywords = keywords.filter(
			(keyword): keyword is string => typeof keyword === "string",
		);
	}
	if (isObjectRecord(og)) meta.og = pickStrings(og, OG_FIELDS);
	if (isObjectRecord(twitter)) {
		const tags: TwitterTags = pickStrings(twitter, TWITTER_STRING_FIELDS);
		if (isTwitterCard(twitter.card)) tags.card = twitter.card;
		meta.twitter = tags;
	}
	if (Array.isArray(custom)) {
		meta.custom = custom
			.filter(isObjectRecord)
			.map((entry) => pickStrings(entry, CUSTOM_FIELDS));
	}
	if (
		typeof jsonLd === "object" &&
		jsonLd !== null &&
		(!Array.isArray(jsonLd) ||
			jsonLd.every((node) => typeof node === "object" && node !== null))
	) {
		meta.jsonLd = jsonLd;
	}
	return meta;
}
