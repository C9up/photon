/**
 * `useForm` for Svelte 5 — the form's fields at the top level
 * (`bind:value={form.email}`), its errors and submission state beside them,
 * as `useForm` in `@inertiajs/svelte` 3.7.1. The logic is Photon's
 * framework-free form core; a `$state` counter bumped on every change is what
 * the getters read, so Svelte re-renders what read the form.
 */

import { createForm } from "../form.js";

const STATE_KEYS = [
	"errors",
	"hasErrors",
	"processing",
	"progress",
	"isDirty",
	"wasSuccessful",
	"recentlySuccessful",
];

/**
 * @param {string | Record<string, unknown> | (() => Record<string, unknown>)} keyOrData
 * @param {Record<string, unknown> | (() => Record<string, unknown>)} [maybeData]
 */
export function useForm(keyOrData, maybeData) {
	let store;
	if (typeof keyOrData === "string") {
		if (maybeData === undefined) {
			throw new Error("useForm(rememberKey, data) needs the data too.");
		}
		store = createForm(maybeData, { rememberKey: keyOrData });
	} else {
		store = createForm(keyOrData);
	}
	let version = $state(0);
	store.subscribe(() => {
		version++;
	});
	const read = () => {
		void version;
		return store.getSnapshot();
	};

	const form = {
		data: () => read().data,
		transform(callback) {
			store.transform(callback);
			return form;
		},
		setDefaults: store.setDefaults,
		reset: store.reset,
		setError: store.setError,
		clearErrors: store.clearErrors,
		resetAndClearErrors: store.resetAndClearErrors,
		submit: store.submit,
		get: store.get,
		post: store.post,
		put: store.put,
		patch: store.patch,
		delete: store.delete,
		cancel: store.cancel,
	};
	for (const key of Object.keys(store.getSnapshot().data)) {
		Object.defineProperty(form, key, {
			enumerable: true,
			get: () => read().data[key],
			set: (value) => store.setData(key, value),
		});
	}
	for (const key of STATE_KEYS) {
		Object.defineProperty(form, key, {
			enumerable: true,
			get: () => read()[key],
		});
	}
	return form;
}
