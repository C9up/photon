/**
 * Prop helpers — the surface a controller writes.
 *
 * These carry the AdonisJS Inertia names and semantics exactly, because that is
 * what a migrated controller calls:
 *
 *   return ctx.photon.render('Users/Index', {
 *     users,                                  // sent on every visit
 *     permissions: always(userPermissions),   // never dropped by a partial reload
 *     auditLogs: optional(() => Audit.all()), // resolved ONLY when asked for
 *   })
 *
 * The implementation underneath is ours; the names, the shapes and the
 * behaviour are theirs.
 */

/** Brands a prop so the resolver can tell the kinds apart at runtime. */
const PROP_KIND = Symbol.for("photon.propKind");

type PropKind = "always" | "optional" | "defer" | "merge" | "once" | "scroll";

interface BrandedProp<K extends PropKind, T> {
	readonly [PROP_KIND]: K;
	readonly value: T;
}

/** A value that survives every partial reload. */
export type AlwaysProp<T = unknown> = BrandedProp<"always", T>;

/**
 * A resolver that only runs when the prop is explicitly requested. The function
 * is NOT called otherwise — that is the whole point: an expensive query stays
 * unevaluated on a normal visit.
 */
export type OptionalProp<T = unknown> = BrandedProp<
	"optional",
	() => T | Promise<T>
>;

/**
 * A resolver the client fetches in a FOLLOW-UP request.
 *
 * The initial page carries only the prop's NAME, grouped; the client then
 * issues one partial reload per group. That is how a page paints immediately
 * and fills its slow panels afterwards.
 */
export interface DeferProp<T = unknown> {
	readonly [PROP_KIND]: "defer";
	readonly value: () => T | Promise<T>;
	readonly group: string;
	/** When true, a resolver that throws omits the prop instead of failing the
	 * whole reload; its name is reported so the page can show a fallback. */
	readonly rescue: boolean;
}

/**
 * A prop the client COMBINES with what it already holds instead of replacing.
 *
 * The value travels normally; what changes is the label beside it, which tells
 * the client to append (or prepend, or merge recursively). That is how an
 * "load more" list grows without the server resending everything.
 *
 * The chainable methods mutate and return the same wrapper, so they compose:
 * `merge(rows).prepend().matchOn('id')`.
 */
export interface MergeProp<T = unknown> {
	readonly [PROP_KIND]: "merge";
	/** The value, or the `defer`/`optional`/`always` prop wrapping it. */
	readonly value: T;
	/** Merge recursively into an object rather than concatenating a list. */
	readonly deep: boolean;
	/** Put the incoming items BEFORE the ones the client holds. */
	prependIntent: boolean;
	/** The field that identifies a record, when there is one. */
	matchKey: string | undefined;
	/** Merge before what the client holds — a feed that grows upward. */
	prepend(): MergeProp<T>;
	/** Merge after what the client holds. This is the default. */
	append(): MergeProp<T>;
	/**
	 * Identify records by `key`, so one that is sent twice replaces its twin
	 * instead of appearing twice.
	 */
	matchOn(key: string): MergeProp<T>;
}

/**
 * A prop the client keeps across visits, so the server stops resending it.
 *
 * The server always states the caching terms — the key and when it goes stale.
 * The client then advertises which keys it still holds, and those props are not
 * resolved at all. That is how a lookup table costs one query per session
 * rather than one per page.
 */
export interface OnceProp<T = unknown> {
	readonly [PROP_KIND]: "once";
	/** The value, or the prop wrapping it. */
	readonly value: T;
	/** The cache key. Defaults to the prop's own name. */
	readonly onceKey: string | undefined;
	/** How long the client may keep it — ms, or `'1h'`, `'30m'`, `'7d'`. */
	readonly expiresIn: number | string | undefined;
	/** An absolute deadline, which wins over `expiresIn`. */
	readonly expiresAt: number | Date | undefined;
	/** Resolve even when the client says it already holds a fresh copy. */
	readonly fresh: boolean;
}

/** Where the client is in a paginated list, and where it can go next. */
export interface ScrollCursor {
	/** The query-string parameter that carries the page — usually `page`. */
	readonly pageName: string;
	readonly currentPage: number | string | null;
	/** null when this is the last page — that is how the client stops asking. */
	readonly nextPage: number | string | null;
	readonly previousPage: number | string | null;
}

/** Derives the cursor from a resolved value. */
export type ScrollCursorProvider = (
	value: unknown,
) => ScrollCursor | Promise<ScrollCursor>;

/**
 * A paginated list the client keeps extending as the user scrolls.
 *
 * It is a mergeable prop with a cursor: the value's `data` array is labelled
 * for merging (so page 2 joins page 1 instead of replacing it) and the cursor
 * travels beside it, telling the client which page to ask for next.
 */
export interface ScrollProp<T = unknown> {
	readonly [PROP_KIND]: "scroll";
	/** A `{ data }`-shaped value, or a callback returning one. */
	readonly value: T;
	readonly provider: ScrollCursorProvider;
	/** Set by `.deferred()`: skip the first page on the initial load. */
	group: string | undefined;
	/** The field identifying a row, so overlapping pages do not duplicate it. */
	matchKey: string | undefined;
	/** Skip the first page on the initial load and fetch it right after. */
	deferred(group?: string): ScrollProp<T>;
	/** Dedupe overlapping pages by this field — `matchOn('id')`. */
	matchOn(key: string): ScrollProp<T>;
}

/** Any prop the resolver has to unwrap. */
export type SpecialProp =
	| AlwaysProp
	| OptionalProp
	| DeferProp
	| MergeProp
	| OnceProp
	| ScrollProp;

export interface OnceOptions {
	readonly key?: string;
	readonly expiresIn?: number | string;
	readonly expiresAt?: number | Date;
	readonly fresh?: boolean;
}

/**
 * Send this prop once, then let the client keep it.
 *
 *   once(() => loadCountries())                    // for the whole session
 *   once(() => rates(), { expiresIn: '1h' })       // until it goes stale
 *   defer(() => stats()).once({ key: 'stats' })    // composed
 *
 * On a later visit the client says which keys it still holds and the resolver
 * is skipped entirely — the point is the query that never runs.
 */
export function once<T>(value: T, options: OnceOptions = {}): OnceProp<T> {
	return {
		[PROP_KIND]: "once",
		value,
		onceKey: options.key,
		expiresIn: options.expiresIn,
		expiresAt: options.expiresAt,
		fresh: options.fresh ?? false,
	};
}

export interface DeferOptions {
	readonly group?: string;
	readonly rescue?: boolean;
}

/**
 * Always include this prop, even in a partial reload that did not ask for it.
 *
 * Use it for what a page cannot render without — the signed-in user, the
 * permission set, a flash message.
 */
export function always<T>(value: T): AlwaysProp<T> {
	return { [PROP_KIND]: "always", value };
}

/**
 * Resolve this prop ONLY when a partial reload asks for it by name.
 *
 * The resolver is never invoked on a normal visit, so an expensive query costs
 * nothing until a page actually requests it.
 */
export function optional<T>(fn: () => T | Promise<T>): OptionalProp<T> {
	return { [PROP_KIND]: "optional", value: fn };
}

/**
 * Resolve this prop in a follow-up request, not in the page itself.
 *
 * `defer(() => Stats.heavy())` — or `defer(fn, 'dashboard')` to fetch several
 * together, since the client makes one request per group.
 */
export function defer<T>(
	fn: () => T | Promise<T>,
	groupOrOptions?: string | DeferOptions,
): DeferProp<T> {
	const options =
		typeof groupOrOptions === "string"
			? { group: groupOrOptions }
			: (groupOrOptions ?? {});
	return {
		[PROP_KIND]: "defer",
		value: fn,
		group: options.group ?? "default",
		rescue: options.rescue ?? false,
	};
}

/** The wrapper shared by `merge` and `deepMerge`. */
function mergeable<T>(value: T, deep: boolean): MergeProp<T> {
	return {
		[PROP_KIND]: "merge",
		value,
		deep,
		prependIntent: false,
		matchKey: undefined,
		prepend() {
			this.prependIntent = true;
			return this;
		},
		append() {
			this.prependIntent = false;
			return this;
		},
		matchOn(key: string) {
			this.matchKey = key;
			return this;
		},
	};
}

/**
 * Combine this prop with what the client already holds, rather than replacing.
 *
 * `merge(nextPage)` appends to the list already on screen — the shape a
 * paginated feed or a "load more" button needs.
 */
export function merge<T>(value: T): MergeProp<T> {
	return mergeable(value, false);
}

/**
 * Merge recursively into what the client holds.
 *
 * Use it for an object whose branches arrive separately — `deepMerge(settings)`
 * updates the keys it carries and leaves the rest of the tree alone.
 */
export function deepMerge<T>(value: T): MergeProp<T> {
	return mergeable(value, true);
}

function kindOf(value: unknown): PropKind | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const kind = Reflect.get(value, PROP_KIND);
	return kind === "always" ||
		kind === "optional" ||
		kind === "defer" ||
		kind === "merge" ||
		kind === "once" ||
		kind === "scroll"
		? kind
		: undefined;
}

export function isMergeProp(value: unknown): value is MergeProp {
	return kindOf(value) === "merge";
}

export function isOnceProp(value: unknown): value is OnceProp {
	return kindOf(value) === "once";
}

export function isScrollProp(value: unknown): value is ScrollProp {
	return kindOf(value) === "scroll";
}

/** Read one offset-pagination field off a paginator or its `meta`. */
function pageField(source: unknown, field: string): number | undefined {
	if (typeof source !== "object" || source === null) return undefined;
	const direct = Reflect.get(source, field);
	if (typeof direct === "number") return direct;
	const meta = Reflect.get(source, "meta");
	if (typeof meta !== "object" || meta === null) return undefined;
	const nested = Reflect.get(meta, field);
	return typeof nested === "number" ? nested : undefined;
}

/**
 * The cursor of an offset paginator — an atlas paginator, or any value
 * carrying `currentPage` / `lastPage`, directly or under `meta`.
 *
 * Anything else throws rather than guessing: a cursor paginator or a custom
 * source needs a provider, and silently paginating the wrong way would show
 * the reader the same page forever.
 */
function offsetPaginatorCursor(value: unknown): ScrollCursor {
	const currentPage = pageField(value, "currentPage");
	if (currentPage === undefined) {
		throw new TypeError(
			'Cannot derive an infinite-scroll cursor from this value. Pass a cursor callback as the second argument to "scroll()" for cursor paginators and custom sources.',
		);
	}
	const lastPage = pageField(value, "lastPage") ?? currentPage;
	const firstPage = pageField(value, "firstPage") ?? 1;
	const pageName = pageField(value, "pageName");
	return {
		pageName: typeof pageName === "string" ? pageName : "page",
		currentPage,
		nextPage: currentPage < lastPage ? currentPage + 1 : null,
		previousPage: currentPage > firstPage ? currentPage - 1 : null,
	};
}

/**
 * A list the client extends as the user scrolls, rather than replaces.
 *
 *   scroll(() => User.query().paginate(page, 20))
 *   scroll(() => feed, (v) => ({ pageName: 'cursor', currentPage: v.cursor,
 *     nextPage: v.next, previousPage: null }))
 *
 * Chain `.matchOn('id')` so overlapping pages do not show a row twice, and
 * `.deferred()` to let the page paint before its first rows arrive.
 */
export function scroll<T>(
	value: T,
	provider: ScrollCursorProvider = offsetPaginatorCursor,
): ScrollProp<T> {
	return {
		[PROP_KIND]: "scroll",
		value,
		provider,
		group: undefined,
		matchKey: undefined,
		deferred(group = "default") {
			this.group = group;
			return this;
		},
		matchOn(key: string) {
			this.matchKey = key;
			return this;
		},
	};
}

const DURATION_UNITS: ReadonlyMap<string, number> = new Map([
	["ms", 1],
	["s", 1000],
	["m", 60_000],
	["h", 3_600_000],
	["d", 86_400_000],
	["w", 604_800_000],
]);

/**
 * A human duration in milliseconds — `'500ms'`, `'30s'`, `'5m'`, `'2h'`, `'7d'`.
 *
 * A bare number is already milliseconds. Anything unparseable throws rather
 * than silently becoming a cache entry that never expires, or one that expires
 * immediately; both are worse than a loud failure at render time.
 */
function durationToMs(value: number | string): number {
	if (typeof value === "number") return value;
	const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/i.exec(value);
	const unit = DURATION_UNITS.get((match?.[2] ?? "ms").toLowerCase());
	if (match?.[1] === undefined || unit === undefined) {
		throw new TypeError(
			`Cannot read "${value}" as a duration. Use milliseconds, or a unit: 500ms, 30s, 5m, 2h, 7d, 1w.`,
		);
	}
	return Number(match[1]) * unit;
}

/** The absolute deadline a once prop states, or null when it never expires. */
function expiryOf(prop: OnceProp, now: number): number | null {
	if (prop.expiresAt !== undefined) {
		return prop.expiresAt instanceof Date
			? prop.expiresAt.getTime()
			: prop.expiresAt;
	}
	if (prop.expiresIn !== undefined) return now + durationToMs(prop.expiresIn);
	return null;
}

/** Whether a bare value is a lazy prop the render has to invoke. */
function isThunk(value: unknown): value is () => unknown {
	return typeof value === "function";
}

export function isDeferProp(value: unknown): value is DeferProp {
	return kindOf(value) === "defer";
}

export function isAlwaysProp(value: unknown): value is AlwaysProp {
	return kindOf(value) === "always";
}

export function isOptionalProp(value: unknown): value is OptionalProp {
	return kindOf(value) === "optional";
}

/**
 * What the client told us about this request, read from its headers.
 *
 * All of it is optional: a first visit states none of it and gets the whole
 * page, which is exactly the behaviour a plain `render()` needs.
 */
export interface PropsRequest {
	/** Only these prop names. Empty means "no restriction". */
	readonly only: readonly string[];
	/** All props except these. */
	readonly except: readonly string[];
	/** The component the client believes it is reloading. */
	readonly component?: string;
	/**
	 * Props the client wants REPLACED rather than merged, from the reset header.
	 * A name listed here is sent unlabeled, so a mergeable prop overwrites what
	 * the client holds — that is what "reset this list" means.
	 */
	readonly reset?: readonly string[];
	/**
	 * Once-keys the client still holds, from the except-once header. A prop
	 * under one of these keys is not resolved at all — the client already has it.
	 */
	readonly exceptOnce?: readonly string[];
	/**
	 * Reference time for expiry, in epoch-ms. Defaults to now; a test pins it so
	 * the deadlines it asserts do not move.
	 */
	readonly now?: number;
	/**
	 * Which way the client wants new scroll pages joined to the ones it holds.
	 * A reader scrolling up asks to prepend; the default is to append.
	 */
	readonly mergeIntent?: "append" | "prepend";
}

/**
 * The protocol fields a page payload carries beside `props`.
 *
 * Each one is an instruction to the client: fetch these later, combine these
 * with what you already hold, identify records by this key. They are omitted
 * when empty, so a plain page stays a plain page.
 */
export interface PropsProtocolExtras {
	/** Prop names the client must fetch in a follow-up request, by group. */
	readonly deferredProps?: Record<string, string[]>;
	/** Deferred props whose resolver threw under `rescue: true`. */
	readonly rescuedProps?: string[];
	/** Props the client appends to what it already holds. */
	readonly mergeProps?: string[];
	/** Props the client merges recursively into what it holds. */
	readonly deepMergeProps?: string[];
	/** Props the client merges BEFORE what it holds. */
	readonly prependProps?: string[];
	/** `prop.key` pairs naming the field that identifies a record, so a re-sent
	 * one replaces its twin instead of duplicating it. */
	readonly matchPropsOn?: string[];
	/**
	 * The caching terms for every `once` prop, by key: which prop it holds and
	 * when it goes stale (`null` meaning never). Stated even when the value was
	 * skipped, so the client knows its copy is still good.
	 */
	readonly onceProps?: Record<string, OncePropMeta>;
	/**
	 * The pagination cursor of every scroll prop, by name: where the client is
	 * and which page comes next, plus whether it should drop what it cached.
	 */
	readonly scrollProps?: Record<string, ScrollPropMeta>;
}

/** A scroll prop's cursor, as the client receives it. */
export interface ScrollPropMeta extends ScrollCursor {
	/** True when the client asked to start the list over. */
	readonly reset: boolean;
}

/** What the client is told about one cached prop. */
export interface OncePropMeta {
	/** The prop name the cached value belongs to. */
	readonly prop: string;
	/** Epoch-ms deadline, or null when it never goes stale. */
	readonly expiresAt: number | null;
}

/** What a render needs to send: the resolved props plus the protocol extras. */
export interface ResolvedProps {
	readonly props: Record<string, unknown>;
	/** Spread straight into the page payload; empty on an ordinary render. */
	readonly extras: PropsProtocolExtras;
}

/**
 * Decide which props to send, then resolve them.
 *
 * The rules, in the order they apply — the same order upstream uses, because a
 * page's props depend on it:
 *
 *  1. A partial reload only counts for the SAME component. A client asking for
 *     a partial of `Users/Index` while the server is rendering `Posts/Index`
 *     gets the full set, never a half-filled page.
 *  2. `only` narrows to the named props; `except` removes them.
 *  3. An `always` prop survives both — that is what it is for.
 *  4. An `optional` prop is dropped unless explicitly named, and its resolver
 *     is not called when it is dropped.
 *  5. A `defer` prop is skipped on a standard visit; only its NAME travels, so
 *     the client knows to come back for it. On the partial that names it, it
 *     resolves like any other prop.
 *  6. A `merge` prop is resolved like whatever it wraps, and additionally
 *     LABELLED, so the client combines the value with what it already holds
 *     instead of replacing it.
 */
export async function resolveProps(
	props: Record<string, unknown>,
	component: string,
	partial?: PropsRequest,
): Promise<ResolvedProps> {
	const partialApplies =
		partial !== undefined &&
		(partial.only.length > 0 || partial.except.length > 0) &&
		(partial.component === undefined || partial.component === component);

	const only = new Set(partialApplies ? partial.only : []);
	const except = new Set(partialApplies ? partial.except : []);
	// Reset is read whether or not the partial applies: it labels, it does not
	// filter, so a component mismatch has no bearing on it.
	const reset = new Set(partial?.reset ?? []);
	const exceptOnce = new Set(partial?.exceptOnce ?? []);
	const now = partial?.now ?? Date.now();
	const named = (key: string): boolean =>
		partialApplies && (only.size === 0 || only.has(key)) && !except.has(key);

	const out: Record<string, unknown> = {};
	const deferred: Record<string, string[]> = {};
	const rescued: string[] = [];
	const merged: string[] = [];
	const deepMerged: string[] = [];
	const prepended: string[] = [];
	const matched: string[] = [];
	const cached: Record<string, OncePropMeta> = {};
	const cursors: Record<string, ScrollPropMeta> = {};
	const mergeIntent = partial?.mergeIntent ?? "append";

	/**
	 * Put a value in the payload.
	 *
	 * A bare callback is a lazy prop, invoked on every render — a controller
	 * writes `{ total: () => countOrders() }` and expects the number, not the
	 * function. A promise is awaited for the same reason.
	 */
	const emit = async (key: string, value: unknown): Promise<void> => {
		out[key] = isThunk(value) ? await value() : await value;
	};

	/**
	 * Resolve one entry into the accumulators above.
	 *
	 * Returns whether the prop reached the payload — either as a value or as a
	 * deferred announcement — so a wrapper around it knows whether labelling it
	 * would tell the client about something that is not there.
	 */
	const take = async (key: string, raw: unknown): Promise<boolean> => {
		if (isOnceProp(raw)) {
			const cacheKey = raw.onceKey ?? key;
			// Stated whether or not the value is sent: the client needs the terms
			// to know its own copy is still usable.
			cached[cacheKey] = { prop: key, expiresAt: expiryOf(raw, now) };
			// The client only advertises a key while it holds a present, unexpired
			// value, so we take it at its word — unless the prop forces a refresh.
			if (exceptOnce.has(cacheKey) && !raw.fresh) return false;
			return take(key, raw.value);
		}

		if (isScrollProp(raw)) {
			// `.deferred()` holds the first page back so the page can paint; the
			// client then asks for it like any other deferred prop.
			const deferring = raw.group !== undefined && !named(key);
			if (!deferring && partialApplies && !named(key)) return false;

			// The client merges the `data` ARRAY, not the whole prop — the cursor
			// beside it must be replaced each time, never accumulated.
			if (!reset.has(key)) {
				const path = `${key}.data`;
				if (mergeIntent === "prepend") prepended.push(path);
				else merged.push(path);
				if (raw.matchKey !== undefined) matched.push(`${path}.${raw.matchKey}`);
			}

			if (deferring && raw.group !== undefined) {
				const group = deferred[raw.group] ?? [];
				group.push(key);
				deferred[raw.group] = group;
				return true;
			}

			const value = isThunk(raw.value) ? await raw.value() : await raw.value;
			// The cursor comes from the value the client is about to receive, so
			// the two can never describe different pages.
			cursors[key] = { ...(await raw.provider(value)), reset: reset.has(key) };
			out[key] = value;
			return true;
		}

		if (isMergeProp(raw)) {
			// Resolve what it wraps first: the inner prop decides whether anything
			// is sent at all, and a merge label on an absent prop means nothing.
			const sent = await take(key, raw.value);
			// A prop the client asked to reset is deliberately left unlabeled, so
			// the value replaces what it holds rather than combining with it.
			if (sent && !reset.has(key)) {
				if (raw.deep) deepMerged.push(key);
				else if (raw.prependIntent) prepended.push(key);
				else merged.push(key);
				if (raw.matchKey !== undefined) matched.push(`${key}.${raw.matchKey}`);
			}
			return sent;
		}

		if (isAlwaysProp(raw)) {
			// Deliberately past the partial gate below: surviving `only`/`except`
			// is the entire reason this wrapper exists.
			await emit(key, raw.value);
			return true;
		}

		if (isDeferProp(raw)) {
			if (!named(key)) {
				// Standard visit (or a partial that did not ask): announce the name
				// so the client can fetch it, and do not run the resolver.
				const group = deferred[raw.group] ?? [];
				group.push(key);
				deferred[raw.group] = group;
				return true;
			}
			if (!raw.rescue) {
				out[key] = await raw.value();
				return true;
			}
			try {
				out[key] = await raw.value();
				return true;
			} catch {
				// `rescue` means one slow panel failing must not take the whole
				// reload with it; the page renders its fallback instead.
				rescued.push(key);
				return false;
			}
		}

		if (isOptionalProp(raw)) {
			if (!named(key)) return false;
			out[key] = await raw.value();
			return true;
		}

		if (partialApplies && !named(key)) return false;
		await emit(key, raw);
		return true;
	};

	for (const [key, raw] of Object.entries(props)) {
		await take(key, raw);
	}

	return {
		props: out,
		extras: {
			...(Object.keys(deferred).length > 0 ? { deferredProps: deferred } : {}),
			...(rescued.length > 0 ? { rescuedProps: rescued } : {}),
			...(merged.length > 0 ? { mergeProps: merged } : {}),
			...(deepMerged.length > 0 ? { deepMergeProps: deepMerged } : {}),
			...(prepended.length > 0 ? { prependProps: prepended } : {}),
			...(matched.length > 0 ? { matchPropsOn: matched } : {}),
			...(Object.keys(cached).length > 0 ? { onceProps: cached } : {}),
			...(Object.keys(cursors).length > 0 ? { scrollProps: cursors } : {}),
		},
	};
}
