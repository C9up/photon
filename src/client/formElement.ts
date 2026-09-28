/// <reference lib="dom" />
/**
 * Photon — the logic of a `<Form>` component, without a framework.
 *
 * `<Form>` in `@inertiajs/react`, `/vue3` and `/svelte` reads its data from
 * the `<form>` element itself: `FormData` at submit, the fields' own values
 * as the defaults `isDirty` compares to and `reset` puts back. Each copy
 * carries that logic; Photon has it once, here, and each framework's `Form`
 * renders the element and forwards to it. Ported from `@inertiajs/core`
 * 3.7.1 (`formDataToObject`, `resetFormFields`) and the React `Form`, read
 * from their source; Laravel Precognition is not ported (see `form.ts`).
 *
 * Browser-only — strict no `node:` imports.
 */

import { createForm, type FormErrors } from "./form.js";
import {
	type Method,
	type RequestPayload,
	type VisitOptions,
	withQuery,
} from "./router.js";

// ─── FormData → object (`formDataToObject`) ─────────────────────────────

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** Stands in for an escaped `\.` while dots are split: a private-use character. */
const ESCAPED_DOT = "\uE000";

/** `a.b` → `a[b]`, as the names of a form's fields are read. */
function undotKey(key: string): string {
	if (!key.includes(".")) return key;
	return key
		.replace(/\\\./g, ESCAPED_DOT)
		.split(/(\[[^\]]*\])/)
		.filter(Boolean)
		.map((segment) =>
			segment.startsWith("[") && segment.endsWith("]")
				? segment
				: segment
						.split(".")
						.reduce((result, part, index) =>
							index === 0 ? part : `${result}[${part}]`,
						),
		)
		.join("")
		.replaceAll(ESCAPED_DOT, ".");
}

/** `a[b][0][]` → `["a", "b", 0, ""]`. */
function parseKey(key: string): Array<string | number> {
	const path: Array<string | number> = [];
	const pattern = /([^[\]]+)|\[(\d*)\]/g;
	let match = pattern.exec(key);
	while (match !== null) {
		if (match[1] !== undefined) path.push(match[1]);
		else if (match[2] !== undefined) {
			path.push(match[2] === "" ? "" : Number(match[2]));
		}
		match = pattern.exec(key);
	}
	return path;
}

type Tree = Record<string, unknown>;

function isTree(value: unknown): value is Tree {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Blob)
	);
}

function childTree(parent: Tree, key: string): Tree {
	const existing = parent[key];
	if (isTree(existing)) return existing;
	const created: Tree = {};
	parent[key] = created;
	return created;
}

/** `{0: a, 1: b}` → `[a, b]`, all the way down. */
function sequentialToArrays(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sequentialToArrays);
	if (!isTree(value)) return value;
	const keys = Object.keys(value);
	const numeric = keys
		.filter((key) => /^\d+$/.test(key))
		.map(Number)
		.sort((a, b) => a - b);
	if (
		numeric.length > 0 &&
		numeric.length === keys.length &&
		numeric.every((n, i) => n === i)
	) {
		return numeric.map((n) => sequentialToArrays(value[String(n)]));
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, inner]) => [
			key,
			sequentialToArrays(inner),
		]),
	);
}

/**
 * A form's `FormData` as the nested object its field names describe —
 * `user[name]`, `tags[]`, `rows[0][id]` — with empty file inputs left out.
 */
export function formDataToObject(source: FormData): Tree {
	const form: Tree = {};
	for (const [key, value] of source.entries()) {
		if (value instanceof File && value.size === 0 && value.name === "")
			continue;
		const path = parseKey(undotKey(key)).map(String);
		if (path.some((segment) => FORBIDDEN.has(segment))) continue;
		const last = path[path.length - 1];
		if (last === undefined) continue;
		let node = form;
		if (last === "") {
			for (const segment of path.slice(0, -2)) node = childTree(node, segment);
			const arrayKey = path[path.length - 2];
			if (arrayKey === undefined) continue;
			const existing = node[arrayKey];
			node[arrayKey] = Array.isArray(existing) ? [...existing, value] : [value];
			continue;
		}
		for (const segment of path.slice(0, -1)) node = childTree(node, segment);
		node[last] = value;
	}
	const converted = sequentialToArrays(form);
	return isTree(converted) ? converted : {};
}

// ─── Reset fields to defaults (`resetFormFields`) ────────────────────────

type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function isField(element: unknown): element is FieldElement {
	return (
		element instanceof HTMLInputElement ||
		element instanceof HTMLSelectElement ||
		element instanceof HTMLTextAreaElement
	);
}

function asText(value: FormDataEntryValue | undefined): string {
	return typeof value === "string" ? value : "";
}

function resetInput(
	input: HTMLInputElement,
	defaults: FormDataEntryValue[],
): boolean {
	const oldValue = input.value;
	const oldChecked = input.checked;
	switch (input.type.toLowerCase()) {
		case "checkbox":
			input.checked = defaults.includes(input.value);
			break;
		case "radio":
			input.checked = defaults[0] === input.value;
			break;
		case "file":
			input.value = "";
			break;
		case "button":
		case "submit":
		case "reset":
		case "image":
			break;
		default:
			input.value = asText(defaults[0]);
	}
	return input.value !== oldValue || input.checked !== oldChecked;
}

function resetField(
	element: FieldElement,
	defaults: FormDataEntryValue[],
): boolean {
	if (element instanceof HTMLInputElement) return resetInput(element, defaults);
	if (element instanceof HTMLSelectElement) {
		const before = [...element.selectedOptions]
			.map((option) => option.value)
			.join("\n");
		if (element.multiple) {
			const wanted = defaults.map(String);
			for (const option of element.options)
				option.selected = wanted.includes(option.value);
		} else {
			element.value = asText(defaults[0]);
		}
		return (
			[...element.selectedOptions].map((option) => option.value).join("\n") !==
			before
		);
	}
	const oldValue = element.value;
	element.value = asText(defaults[0]);
	return element.value !== oldValue;
}

/**
 * Put the fields named in `fields` — or every field — back to `defaults`,
 * the form's `FormData` when it was last made the baseline.
 */
export function resetFormFields(
	form: HTMLFormElement,
	defaults: FormData,
	fields: string[] = [],
): void {
	const names =
		fields.length > 0
			? fields
			: [
					...new Set([
						...defaults.keys(),
						...new FormData(form).keys(),
						...[...form.elements].map((element) =>
							isField(element) ? element.name : "",
						),
					]),
				].filter(Boolean);
	for (const name of names) {
		const found = form.elements.namedItem(name);
		const values = defaults.getAll(name);
		if (found instanceof RadioNodeList) {
			[...found].forEach((node, index) => {
				if (!isField(node)) return;
				const checkable =
					node instanceof HTMLInputElement &&
					(node.type === "checkbox" || node.type === "radio");
				const value = values[index];
				resetField(node, checkable || value === undefined ? values : [value]);
			});
		} else if (isField(found)) {
			resetField(found, values);
		}
	}
}

// ─── The controller ─────────────────────────────────────────────────────

/** `value` with every file replaced by what identifies it, for comparing. */
function comparable(value: unknown): unknown {
	if (value instanceof File) {
		return `file:${value.name}:${value.size}:${value.lastModified}`;
	}
	if (Array.isArray(value)) return value.map(comparable);
	if (isTree(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, inner]) => [key, comparable(inner)]),
		);
	}
	return value;
}

/** What `<Form>` is given beside its element. */
export interface FormComponentOptions extends VisitOptions {
	/** The URL to submit to. */
	action?: string;
	/** Default `get`. */
	method?: Method;
	/** What the collected data becomes before it is sent. */
	transform?: (data: Tree) => RequestPayload;
	/** Extra visit options, merged last. */
	options?: VisitOptions;
	/** After a success, with `reset` and `defaults` to call. */
	onSubmitComplete?(props: {
		reset: (...fields: string[]) => void;
		defaults: () => void;
	}): void;
	resetOnSuccess?: boolean | string[];
	resetOnError?: boolean | string[];
	setDefaultsOnSuccess?: boolean;
	cancelOnUnmount?: boolean;
}

/** What `<Form>` gives its children — the React `Form`'s exposed object. */
export interface FormSlotProps {
	errors: FormErrors;
	hasErrors: boolean;
	processing: boolean;
	progress: null;
	wasSuccessful: boolean;
	recentlySuccessful: boolean;
	isDirty: boolean;
	clearErrors(...fields: string[]): void;
	resetAndClearErrors(...fields: string[]): void;
	setError(field: string | FormErrors, message?: string): void;
	reset(...fields: string[]): void;
	submit(submitter?: HTMLElement | null): void;
	cancel(): void;
	defaults(): void;
	getData(): Tree;
	getFormData(): FormData;
}

export interface FormController {
	/** Start following `element`: its values become the defaults. */
	mount(element: HTMLFormElement): void;
	unmount(): void;
	/** The slot props; a new object whenever something in them changed. */
	getSnapshot(): FormSlotProps;
	subscribe(listener: () => void): () => void;
}

/**
 * The logic of one `<Form>`. `read()` returns the component's current props
 * each time, so a re-render with new props is seen at the next submit.
 */
export function createFormController(
	read: () => FormComponentOptions,
): FormController {
	const form = createForm<Tree>({});
	let element: HTMLFormElement | null = null;
	let defaultData = new FormData();
	let isDirty = false;
	const listeners = new Set<() => void>();

	const getFormData = (submitter?: HTMLElement | null): FormData =>
		element ? new FormData(element, submitter ?? undefined) : new FormData();
	const getData = (submitter?: HTMLElement | null): Tree =>
		formDataToObject(getFormData(submitter));

	const reset = (...fields: string[]): void => {
		if (element) resetFormFields(element, defaultData, fields);
		form.reset(...fields);
		updateDirty();
	};
	const defaults = (): void => {
		defaultData = getFormData();
		isDirty = false;
		publish();
	};
	const maybeReset = (option: boolean | string[] | undefined): void => {
		if (option === true) reset();
		else if (Array.isArray(option) && option.length > 0) reset(...option);
	};

	const submit = (submitter?: HTMLElement | null): void => {
		const props = read();
		const method = props.method ?? "get";
		const action = props.action ?? "";
		const collected = getData(submitter);
		const url = method === "get" ? withQuery(action, collected) : action;
		const data = method === "get" ? {} : collected;
		const transform = props.transform ?? ((value: Tree) => value);
		form.transform(() => transform(data));
		void form.submit(method, url, {
			headers: props.headers,
			errorBag: props.errorBag,
			onCancelToken: props.onCancelToken,
			onBefore: props.onBefore,
			onStart: props.onStart,
			onFinish: props.onFinish,
			onCancel: props.onCancel,
			onSuccess: (page) => {
				props.onSuccess?.(page);
				props.onSubmitComplete?.({ reset, defaults });
				maybeReset(props.resetOnSuccess);
				if (props.setDefaultsOnSuccess === true) defaults();
			},
			onError: (errors) => {
				props.onError?.(errors);
				maybeReset(props.resetOnError);
			},
			...props.options,
		});
	};

	const exposed = (): FormSlotProps => {
		const state = form.getSnapshot();
		return {
			errors: state.errors,
			hasErrors: state.hasErrors,
			processing: state.processing,
			progress: state.progress,
			wasSuccessful: state.wasSuccessful,
			recentlySuccessful: state.recentlySuccessful,
			isDirty,
			clearErrors: (...fields) => form.clearErrors(...fields),
			resetAndClearErrors: (...fields) => {
				form.clearErrors(...fields);
				reset(...fields);
			},
			setError: (field, message) => {
				if (typeof field === "string") form.setError(field, message ?? "");
				else form.setError(field);
			},
			reset,
			submit,
			cancel: () => form.cancel(),
			defaults,
			getData: () => getData(),
			getFormData: () => getFormData(),
		};
	};

	let snapshot = exposed();
	function publish(): void {
		snapshot = exposed();
		for (const listener of listeners) listener();
	}
	form.subscribe(publish);

	/** Equal data; a file compares by name, size and date, not as `{}`. */
	function sameData(a: Tree, b: Tree): boolean {
		return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
	}
	function updateDirty(event?: Event): void {
		const next =
			event?.type === "reset"
				? false
				: !sameData(getData(), formDataToObject(defaultData));
		if (next !== isDirty) {
			isDirty = next;
			publish();
		}
	}
	const onFieldEvent = (event: Event): void => {
		// Let the native reset land first; the values are read after it.
		setTimeout(() => updateDirty(event), 0);
	};

	return {
		mount(target) {
			element = target;
			defaultData = getFormData();
			for (const type of ["input", "change", "reset"]) {
				target.addEventListener(type, onFieldEvent);
			}
		},
		unmount() {
			for (const type of ["input", "change", "reset"]) {
				element?.removeEventListener(type, onFieldEvent);
			}
			if (read().cancelOnUnmount === true) form.cancel();
			form.dispose();
			element = null;
		},
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
