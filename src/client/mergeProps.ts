/**
 * Photon — combine the props of a partial reload with the ones on screen.
 *
 * The server labels a prop `merge()`, `deepMerge()` or `merge().prepend()` when
 * each answer carries only the NEXT slice of it — the next page of a feed, the
 * branch of a settings tree that changed. Replacing the prop with that slice,
 * which is what the router did, showed page 2 instead of pages 1 and 2.
 *
 * The rules are `@inertiajs/core`'s (3.7.1, `mergeProps` / `mergeOrMatchItems`),
 * read from its source:
 * - only on a partial reload of the same component;
 * - `mergeProps` appends an array, `prependProps` puts it first, and an object
 *   is shallow-merged in both cases;
 * - `deepMergeProps` merges objects recursively, arrays at any depth included;
 * - `matchPropsOn` (`prop.key`) makes an array item whose `key` is already
 *   held REPLACE its twin instead of being added again;
 * - a dotted `only` / `except` entry deep-merges its top-level prop, so asking
 *   for `settings.theme` does not drop the rest of `settings`.
 *
 * Paths come from the server, so a segment that would reach an object's
 * prototype (`__proto__`, `constructor`, `prototype`) makes the path ignored.
 *
 * Browser-only — strict no `node:` imports.
 */

/** The labels a page carries about how its props combine. */
export interface MergeInstructions {
	mergeProps?: string[];
	prependProps?: string[];
	deepMergeProps?: string[];
	matchPropsOn?: string[];
}

/** The partial request the answer was for. */
export interface MergeRequest {
	only?: string[];
	except?: string[];
}

type Props = Record<string, unknown>;

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * `incoming` laid over `current`, with every labelled prop combined instead of
 * replaced. Neither argument is modified.
 */
export function mergePartialProps(
	current: Props,
	incoming: Props,
	labels: MergeInstructions,
	request: MergeRequest,
): Props {
	const merged: Props = { ...incoming };
	const matchOn = labels.matchPropsOn ?? [];

	const combine = (path: string, append: boolean): void => {
		const existing = getPath(current, path);
		const next = getPath(incoming, path);
		if (Array.isArray(next)) {
			setPath(merged, path, mergeItems(existing, next, path, matchOn, append));
		} else if (isRecord(next)) {
			setPath(merged, path, {
				...(isRecord(existing) ? existing : {}),
				...next,
			});
		}
	};
	for (const path of labels.mergeProps ?? []) combine(path, true);
	for (const path of labels.prependProps ?? []) combine(path, false);
	for (const path of labels.deepMergeProps ?? []) {
		if (!isSafePath(path)) continue;
		setPath(
			merged,
			path,
			deepMerge(getPath(current, path), getPath(incoming, path), path, matchOn),
		);
	}

	const nestedTopKeys = new Set(
		[...(request.only ?? []), ...(request.except ?? [])]
			.filter((name) => name.includes("."))
			.map((name) => name.split(".")[0] ?? ""),
	);
	for (const key of nestedTopKeys) {
		if (!isSafePath(key)) continue;
		const held = current[key];
		const got = merged[key];
		if (isRecord(held) && isRecord(got))
			merged[key] = deepMergeObjects(held, got);
	}

	return { ...current, ...merged };
}

function mergeItems(
	existing: unknown,
	next: unknown[],
	path: string,
	matchOn: string[],
	append: boolean,
): unknown[] {
	const items = Array.isArray(existing) ? existing : [];
	const matchKey = matchOn.find(
		(key) => key.split(".").slice(0, -1).join(".") === path,
	);
	if (matchKey === undefined) {
		return append ? [...items, ...next] : [...next, ...items];
	}
	const field = matchKey.split(".").pop() ?? "";
	const incomingByKey = new Map<unknown, unknown>();
	for (const item of next) {
		if (hasField(item, field)) incomingByKey.set(item[field], item);
	}
	if (!append) {
		const untouched = items.filter(
			(item) => !(hasField(item, field) && incomingByKey.has(item[field])),
		);
		return [...next, ...untouched];
	}
	const updated = items.map((item) =>
		hasField(item, field) && incomingByKey.has(item[field])
			? incomingByKey.get(item[field])
			: item,
	);
	const added = next.filter(
		(item) =>
			!hasField(item, field) ||
			!items.some(
				(held) => hasField(held, field) && held[field] === item[field],
			),
	);
	return [...updated, ...added];
}

function deepMerge(
	target: unknown,
	source: unknown,
	path: string,
	matchOn: string[],
): unknown {
	if (Array.isArray(source)) {
		return mergeItems(target, source, path, matchOn, true);
	}
	if (isRecord(source)) {
		const out: Props = { ...(isRecord(target) ? target : {}) };
		for (const [key, value] of Object.entries(source)) {
			if (FORBIDDEN_SEGMENTS.has(key)) continue;
			out[key] = deepMerge(
				isRecord(target) ? target[key] : undefined,
				value,
				`${path}.${key}`,
				matchOn,
			);
		}
		return out;
	}
	return source;
}

function deepMergeObjects(target: Props, source: Props): Props {
	const out: Props = { ...target };
	for (const [key, value] of Object.entries(source)) {
		if (FORBIDDEN_SEGMENTS.has(key)) continue;
		const held = target[key];
		out[key] =
			isRecord(held) && isRecord(value) ? deepMergeObjects(held, value) : value;
	}
	return out;
}

function isRecord(value: unknown): value is Props {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasField(
	item: unknown,
	field: string,
): item is Record<string, unknown> {
	return typeof item === "object" && item !== null && field in item;
}

function isSafePath(path: string): boolean {
	return path.split(".").every((segment) => !FORBIDDEN_SEGMENTS.has(segment));
}

function getPath(source: Props, path: string): unknown {
	if (!isSafePath(path)) return undefined;
	let value: unknown = source;
	for (const segment of path.split(".")) {
		if (!isRecord(value)) return undefined;
		value = value[segment];
	}
	return value;
}

/**
 * Write `value` at `path` in `target`, copying each object on the way down so
 * nothing `target` shares with the props on screen is modified.
 */
function setPath(target: Props, path: string, value: unknown): void {
	if (!isSafePath(path)) return;
	const segments = path.split(".");
	const last = segments.pop();
	if (last === undefined) return;
	let node = target;
	for (const segment of segments) {
		const child = node[segment];
		const copy: Props = isRecord(child) ? { ...child } : {};
		node[segment] = copy;
		node = copy;
	}
	node[last] = value;
}

/** What the server says about one `once` prop: where it lives, when it lapses. */
export interface OncePropMeta {
	prop: string;
	/** Epoch milliseconds, or null for never. */
	expiresAt: number | null;
}

/**
 * The `once` keys whose value `page` still holds and has not seen expire —
 * what the client sends as `x-photon-except-once-props`, so the server skips
 * resolving them.
 */
export function heldOnceKeys(
	page: { props: Props; onceProps?: Record<string, OncePropMeta> },
	now: number,
): string[] {
	return Object.entries(page.onceProps ?? {})
		.filter(
			([, meta]) =>
				getPath(page.props, meta.prop) !== undefined &&
				(meta.expiresAt === null || meta.expiresAt > now),
		)
		.map(([key]) => key);
}

/**
 * Put back the `once` values the server skipped because the client said it
 * held them, with the expiry they were first given — `mergeOncePropsIntoResponse`
 * in `@inertiajs/core`. Returns new props and metadata; the arguments are not
 * modified.
 */
export function restoreOnceProps(
	incoming: { props: Props; onceProps?: Record<string, OncePropMeta> },
	held: { props: Props; onceProps?: Record<string, OncePropMeta> },
): { props: Props; onceProps?: Record<string, OncePropMeta> } {
	if (incoming.onceProps === undefined) return incoming;
	const props: Props = { ...incoming.props };
	const onceProps: Record<string, OncePropMeta> = { ...incoming.onceProps };
	for (const [key, meta] of Object.entries(incoming.onceProps)) {
		const before = held.onceProps?.[key];
		if (
			before === undefined ||
			getPath(incoming.props, meta.prop) !== undefined
		) {
			continue;
		}
		setPath(props, meta.prop, getPath(held.props, before.prop));
		onceProps[key] = { prop: meta.prop, expiresAt: before.expiresAt };
	}
	return { props, onceProps };
}
