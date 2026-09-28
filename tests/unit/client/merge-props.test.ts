import { describe, expect, it } from "vitest";
import {
	heldOnceKeys,
	mergePartialProps,
	restoreOnceProps,
} from "../../../src/client/mergeProps.js";

describe("photon/client > mergePartialProps", () => {
	it("replaces a prop nobody labelled", () => {
		expect(
			mergePartialProps({ rows: [1], x: 1 }, { rows: [2] }, {}, {}),
		).toEqual({ rows: [2], x: 1 });
	});

	it("appends a merge prop, and puts a prepend prop first", () => {
		expect(
			mergePartialProps(
				{ feed: [1, 2], log: ["b"] },
				{ feed: [3], log: ["a"] },
				{ mergeProps: ["feed"], prependProps: ["log"] },
				{},
			),
		).toEqual({ feed: [1, 2, 3], log: ["a", "b"] });
	});

	it("shallow-merges an object labelled merge", () => {
		expect(
			mergePartialProps(
				{ counts: { a: 1, b: 1 } },
				{ counts: { b: 2 } },
				{ mergeProps: ["counts"] },
				{},
			),
		).toEqual({ counts: { a: 1, b: 2 } });
	});

	it("follows a dotted path, as a scroll prop's data array is labelled", () => {
		expect(
			mergePartialProps(
				{ users: { data: [1, 2], meta: { page: 1 } } },
				{ users: { data: [3], meta: { page: 2 } } },
				{ mergeProps: ["users.data"] },
				{},
			),
		).toEqual({ users: { data: [1, 2, 3], meta: { page: 2 } } });
	});

	it("replaces a twin instead of adding it again when matched on a key", () => {
		const current = {
			rows: [
				{ id: 1, v: "old" },
				{ id: 2, v: "keep" },
			],
		};
		const incoming = {
			rows: [
				{ id: 1, v: "new" },
				{ id: 3, v: "added" },
			],
		};
		const labels = { mergeProps: ["rows"], matchPropsOn: ["rows.id"] };
		expect(mergePartialProps(current, incoming, labels, {})).toEqual({
			rows: [
				{ id: 1, v: "new" },
				{ id: 2, v: "keep" },
				{ id: 3, v: "added" },
			],
		});
		expect(
			mergePartialProps(
				current,
				incoming,
				{ prependProps: ["rows"], matchPropsOn: ["rows.id"] },
				{},
			),
		).toEqual({
			rows: [
				{ id: 1, v: "new" },
				{ id: 3, v: "added" },
				{ id: 2, v: "keep" },
			],
		});
	});

	it("deep-merges recursively, arrays at any depth included", () => {
		expect(
			mergePartialProps(
				{ tree: { a: { x: 1, list: [1] }, b: 1 } },
				{ tree: { a: { y: 2, list: [2] } } },
				{ deepMergeProps: ["tree"] },
				{},
			),
		).toEqual({ tree: { a: { x: 1, y: 2, list: [1, 2] }, b: 1 } });
	});

	it("keeps the rest of a prop when only a nested key was asked for", () => {
		expect(
			mergePartialProps(
				{ settings: { theme: "dark", lang: "fr" } },
				{ settings: { theme: "light" } },
				{},
				{ only: ["settings.theme"] },
			),
		).toEqual({ settings: { theme: "light", lang: "fr" } });
	});

	it("leaves the props on screen untouched", () => {
		const current = { feed: [1], deep: { a: { b: 1 } } };
		mergePartialProps(
			current,
			{ feed: [2], deep: { a: { c: 2 } } },
			{ mergeProps: ["feed"], deepMergeProps: ["deep"] },
			{},
		);
		expect(current).toEqual({ feed: [1], deep: { a: { b: 1 } } });
	});

	it("ignores a path that reaches for a prototype", () => {
		const merged = mergePartialProps(
			{},
			JSON.parse('{"__proto__": {"polluted": true}, "x": 1}'),
			{ mergeProps: ["__proto__"], deepMergeProps: ["__proto__.polluted"] },
			{ only: ["__proto__.polluted"] },
		);
		expect(Reflect.get({}, "polluted")).toBeUndefined();
		expect(merged.x).toBe(1);
	});
});

describe("photon/client > once props", () => {
	const page = {
		props: { countries: ["CH"], plans: ["free"] },
		onceProps: {
			countries: { prop: "countries", expiresAt: null },
			plans: { prop: "plans", expiresAt: 1_000 },
			tags: { prop: "tags", expiresAt: null },
		},
	};

	it("announces the keys still held and not expired", () => {
		expect(heldOnceKeys(page, 500)).toEqual(["countries", "plans"]);
		// Expired, and one the page never received.
		expect(heldOnceKeys(page, 1_000)).toEqual(["countries"]);
	});

	it("puts back what the server skipped, with its first expiry", () => {
		const next = restoreOnceProps(
			{
				props: { other: 1 },
				onceProps: { plans: { prop: "plans", expiresAt: 9_000 } },
			},
			page,
		);
		expect(next.props).toEqual({ other: 1, plans: ["free"] });
		expect(next.onceProps?.plans?.expiresAt).toBe(1_000);
	});

	it("keeps a value the server did send", () => {
		const next = restoreOnceProps(
			{
				props: { plans: ["pro"] },
				onceProps: { plans: { prop: "plans", expiresAt: 9_000 } },
			},
			page,
		);
		expect(next.props.plans).toEqual(["pro"]);
		expect(next.onceProps?.plans?.expiresAt).toBe(9_000);
	});
});
