/**
 * Photon — the state behind `useForm`, without a framework.
 *
 * `@inertiajs/react`, `/vue3` and `/svelte` each carry their own copy of the
 * form logic; Photon has one, here, and each framework's `useForm` is a thin
 * layer over it (a store React subscribes to, getters Vue and Svelte track).
 * The behaviour is Inertia's 3.7.1 `useForm`, read from its source, under the
 * same names:
 *
 * - `setData(key, value)` (dotted keys), `setData(data)`, `setData(fn)`;
 * - `isDirty` against the defaults, which a successful submit moves to the
 *   submitted data unless `onSuccess` called `setDefaults` itself;
 * - `errors` replaced by the page's validation errors on `onError`, cleared on
 *   success; `wasSuccessful`, and `recentlySuccessful` for two seconds;
 * - `transform` applied to the data at submit, `cancel` through the visit's
 *   cancel token, and a `rememberKey` keeping data and errors in history.
 *
 * Not ported: Laravel Precognition (live validation against a Laravel
 * endpoint, which Ream does not speak), and upload `progress`, which stays
 * null — the router sends with `fetch`, which reports no upload progress.
 *
 * Browser-only — strict no `node:` imports.
 */

import {
	type Method,
	type RequestPayload,
	router,
	type VisitOptions,
} from "./router.js";

/** How long `recentlySuccessful` stays true after a success — Inertia's default. */
const RECENTLY_SUCCESSFUL_MS = 2000;

type Data = Record<string, unknown>;
export type FormErrors = Record<string, string>;

/** What a form shows: its data and where its submission is. */
export interface FormState<T extends Data> {
	data: T;
	isDirty: boolean;
	errors: FormErrors;
	hasErrors: boolean;
	processing: boolean;
	/** Always null: `fetch` reports no upload progress. */
	progress: null;
	wasSuccessful: boolean;
	recentlySuccessful: boolean;
}

export interface FormStore<T extends Data> {
	getSnapshot(): FormState<T>;
	subscribe(listener: () => void): () => void;
	setData(key: string, value: unknown): void;
	setData(data: T): void;
	setData(update: (data: T) => T): void;
	/** Make the current data (or the given fields) the defaults `isDirty` compares to. */
	setDefaults(field?: string | Partial<T>, value?: unknown): void;
	/** Put the defaults back, for every field or the given ones. */
	reset(...fields: string[]): void;
	setError(field: string, message: string): void;
	setError(errors: FormErrors): void;
	clearErrors(...fields: string[]): void;
	resetAndClearErrors(...fields: string[]): void;
	/** What the data becomes when it is sent. */
	transform(callback: (data: T) => RequestPayload): void;
	submit(method: Method, url: string, options?: VisitOptions): Promise<void>;
	get(url: string, options?: VisitOptions): Promise<void>;
	post(url: string, options?: VisitOptions): Promise<void>;
	put(url: string, options?: VisitOptions): Promise<void>;
	patch(url: string, options?: VisitOptions): Promise<void>;
	delete(url: string, options?: VisitOptions): Promise<void>;
	/** Cancel the submission in flight. */
	cancel(): void;
	/** Stop the timers; the form is gone. */
	dispose(): void;
}

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

function clone<T>(value: T): T {
	return structuredClone(value);
}

function isRecord(value: unknown): value is Data {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(source: unknown, path: string): unknown {
	let value: unknown = source;
	for (const segment of path.split(".")) {
		if (typeof value !== "object" || value === null) return undefined;
		value = Reflect.get(value, segment);
	}
	return value;
}

function hasPath(source: unknown, path: string): boolean {
	let value: unknown = source;
	for (const segment of path.split(".")) {
		if (typeof value !== "object" || value === null || !(segment in value)) {
			return false;
		}
		value = Reflect.get(value, segment);
	}
	return true;
}

/** `node` with `value` at `segments`, copied on the way down — arrays stay arrays. */
function setIn(node: unknown, segments: string[], value: unknown): unknown {
	const [head, ...rest] = segments;
	if (head === undefined) return value;
	const child =
		typeof node === "object" && node !== null
			? Reflect.get(node, head)
			: undefined;
	const next = setIn(child, rest, value);
	if (Array.isArray(node)) {
		const copy = [...node];
		copy[Number(head)] = next;
		return copy;
	}
	return { ...(isRecord(node) ? node : {}), [head]: next };
}

/** `source` with `value` at the dotted `path`; the input is untouched. */
function withPath<T extends Data>(source: T, path: string, value: unknown): T {
	const segments = path.split(".");
	if (segments.some((segment) => FORBIDDEN.has(segment))) return source;
	const updated = setIn(source, segments, value);
	return isRecord(updated) ? Object.assign(clone(source), updated) : source;
}

function isEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (a instanceof Blob || b instanceof Blob) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, i) => isEqual(item, b[i]));
	}
	if (isRecord(a) && isRecord(b)) {
		const keys = Object.keys(a);
		return (
			keys.length === Object.keys(b).length &&
			keys.every((key) => isEqual(a[key], b[key]))
		);
	}
	return false;
}

function isFormErrors(value: unknown): value is FormErrors {
	return (
		isRecord(value) &&
		Object.values(value).every((message) => typeof message === "string")
	);
}

export interface CreateFormOptions {
	/** Keep data and errors in the page's history entry under this key. */
	rememberKey?: string;
}

export function createForm<T extends Data>(
	initial: T | (() => T),
	{ rememberKey }: CreateFormOptions = {},
): FormStore<T> {
	const resolve = (): T =>
		clone(typeof initial === "function" ? initial() : initial);
	const remembered = rememberKey
		? router.restore(`${rememberKey}:data`)
		: undefined;
	const rememberedErrors = rememberKey
		? router.restore(`${rememberKey}:errors`)
		: undefined;

	let defaults = resolve();
	let data: T = isRecord(remembered)
		? Object.assign(resolve(), remembered)
		: resolve();
	let errors: FormErrors = isFormErrors(rememberedErrors)
		? { ...rememberedErrors }
		: {};
	let processing = false;
	let wasSuccessful = false;
	let recentlySuccessful = false;
	let recentTimer: ReturnType<typeof setTimeout> | undefined;
	let transformer: (data: T) => RequestPayload = (current) => current;
	let cancelToken: { cancel(): void } | null = null;
	let defaultsSetDuringSuccess = false;

	const listeners = new Set<() => void>();
	let snapshot = buildSnapshot();

	function buildSnapshot(): FormState<T> {
		return {
			data,
			isDirty: !isEqual(data, defaults),
			errors,
			hasErrors: Object.keys(errors).length > 0,
			processing,
			progress: null,
			wasSuccessful,
			recentlySuccessful,
		};
	}

	function changed(): void {
		snapshot = buildSnapshot();
		if (rememberKey) {
			router.remember(data, `${rememberKey}:data`);
			router.remember(errors, `${rememberKey}:errors`);
		}
		for (const listener of listeners) listener();
	}

	function setData(
		keyOrData: string | T | ((data: T) => T),
		value?: unknown,
	): void {
		if (typeof keyOrData === "string") data = withPath(data, keyOrData, value);
		else if (typeof keyOrData === "function") data = keyOrData(data);
		else data = keyOrData;
		changed();
	}

	function setError(
		fieldOrErrors: string | FormErrors,
		message?: string,
	): void {
		errors =
			typeof fieldOrErrors === "string"
				? { ...errors, [fieldOrErrors]: message ?? "" }
				: { ...errors, ...fieldOrErrors };
		changed();
	}

	function clearErrors(...fields: string[]): void {
		errors =
			fields.length === 0
				? {}
				: Object.fromEntries(
						Object.entries(errors).filter(([field]) => !fields.includes(field)),
					);
		changed();
	}

	function reset(...fields: string[]): void {
		const source = typeof initial === "function" ? resolve() : clone(defaults);
		if (typeof initial === "function") defaults = clone(source);
		if (fields.length === 0) {
			data = source;
		} else {
			data = fields
				.filter((field) => hasPath(source, field))
				.reduce(
					(carry, field) => withPath(carry, field, getPath(source, field)),
					data,
				);
		}
		changed();
	}

	async function submit(
		method: Method,
		url: string,
		options: VisitOptions = {},
	): Promise<void> {
		defaultsSetDuringSuccess = false;
		const payload = transformer(data);
		await router.visit(url, {
			...(method === "delete" ? {} : { preserveState: true }),
			...options,
			method,
			data: payload,
			onCancelToken: (token) => {
				cancelToken = token;
				options.onCancelToken?.(token);
			},
			onBefore: (visit) => {
				wasSuccessful = false;
				recentlySuccessful = false;
				clearTimeout(recentTimer);
				changed();
				return options.onBefore?.(visit);
			},
			onStart: (visit) => {
				processing = true;
				changed();
				options.onStart?.(visit);
			},
			onSuccess: (page) => {
				errors = {};
				wasSuccessful = true;
				recentlySuccessful = true;
				recentTimer = setTimeout(() => {
					recentlySuccessful = false;
					changed();
				}, RECENTLY_SUCCESSFUL_MS);
				changed();
				options.onSuccess?.(page);
				// The submitted data is the new baseline, unless `onSuccess` chose one.
				if (!defaultsSetDuringSuccess) defaults = clone(data);
				changed();
			},
			onError: (pageErrors) => {
				errors = Object.fromEntries(
					Object.entries(pageErrors).map(([field, message]) => [
						field,
						Array.isArray(message) ? String(message[0] ?? "") : String(message),
					]),
				);
				changed();
				options.onError?.(pageErrors);
			},
			onCancel: () => options.onCancel?.(),
			onFinish: (visit) => {
				processing = false;
				cancelToken = null;
				changed();
				options.onFinish?.(visit);
			},
		});
	}

	return {
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		setData,
		setDefaults(field, value) {
			if (typeof initial === "function") {
				throw new Error(
					"You cannot call `setDefaults()` when using a function to define your form data.",
				);
			}
			defaultsSetDuringSuccess = true;
			if (field === undefined) defaults = clone(data);
			else if (typeof field === "string")
				defaults = withPath(defaults, field, value);
			else defaults = Object.assign(clone(defaults), field);
			changed();
		},
		reset,
		setError,
		clearErrors,
		resetAndClearErrors(...fields) {
			reset(...fields);
			clearErrors(...fields);
		},
		transform(callback) {
			transformer = callback;
		},
		submit,
		get: (url, options) => submit("get", url, options),
		post: (url, options) => submit("post", url, options),
		put: (url, options) => submit("put", url, options),
		patch: (url, options) => submit("patch", url, options),
		delete: (url, options) => submit("delete", url, options),
		cancel: () => cancelToken?.cancel(),
		dispose: () => clearTimeout(recentTimer),
	};
}
