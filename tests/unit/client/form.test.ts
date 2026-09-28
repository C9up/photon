// @vitest-environment jsdom

/**
 * The form core behind every `useForm` and `<Form>`: the state Inertia's
 * `useForm` keeps, driven through the real router with `fetch` stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createForm } from "../../../src/client/form.js";
import {
	formDataToObject,
	resetFormFields,
} from "../../../src/client/formElement.js";
import { bootRouter, router } from "../../../src/client/router.js";

function page(props: Record<string, unknown> = {}) {
	return new Response(
		JSON.stringify({ component: "Page", framework: "react", url: "/", props }),
		{ headers: { "content-type": "application/json" } },
	);
}

beforeEach(() => {
	sessionStorage.clear();
	bootRouter({
		target: document.body,
		adapter: { update() {}, unmount() {} },
		resolveComponent: async () => ({ default: "Page" }),
		page: { component: "Page", framework: "react", url: "/", props: {} },
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	document.body.replaceChildren();
});

describe("photon/client > form state", () => {
	it("sets fields by dotted path, and knows when it differs from its defaults", () => {
		const form = createForm({ user: { name: "Ada" }, tags: ["a"] });
		expect(form.getSnapshot().isDirty).toBe(false);
		form.setData("user.name", "Grace");
		form.setData("tags.1", "b");
		expect(form.getSnapshot().data).toEqual({
			user: { name: "Grace" },
			tags: ["a", "b"],
		});
		expect(form.getSnapshot().isDirty).toBe(true);
		form.reset("user.name");
		expect(form.getSnapshot().data.user).toEqual({ name: "Ada" });
		form.reset();
		expect(form.getSnapshot().isDirty).toBe(false);
	});

	it("keeps and clears errors by field", () => {
		const form = createForm({ email: "" });
		form.setError("email", "required");
		form.setError({ name: "too short" });
		expect(form.getSnapshot().hasErrors).toBe(true);
		form.clearErrors("email");
		expect(form.getSnapshot().errors).toEqual({ name: "too short" });
		form.resetAndClearErrors();
		expect(form.getSnapshot().hasErrors).toBe(false);
	});

	it("submits the transformed data, then says it succeeded — for two seconds", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
			page(),
		);
		vi.stubGlobal("fetch", fetchMock);
		const form = createForm({ email: "a@b.c", password: "x" });
		form.transform((data) => ({ email: data.email }));
		form.setData("email", "new@b.c");

		const seen: boolean[] = [];
		form.subscribe(() => seen.push(form.getSnapshot().processing));
		await form.post("/login");

		expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"email":"new@b.c"}');
		expect(seen).toContain(true);
		const state = form.getSnapshot();
		expect(state.processing).toBe(false);
		expect(state.wasSuccessful).toBe(true);
		expect(state.recentlySuccessful).toBe(true);
		// The submitted data is the new baseline.
		expect(state.isDirty).toBe(false);
		vi.advanceTimersByTime(2000);
		expect(form.getSnapshot().recentlySuccessful).toBe(false);
	});

	it("takes the page's validation errors on failure, and keeps its defaults", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				page({ errors: { email: "taken", tags: ["one", "two"] } }),
			),
		);
		const form = createForm({ email: "a@b.c" });
		form.setData("email", "dup@b.c");
		const onError = vi.fn();
		await form.post("/signup", { onError });
		expect(form.getSnapshot().errors).toEqual({ email: "taken", tags: "one" });
		expect(form.getSnapshot().wasSuccessful).toBe(false);
		expect(form.getSnapshot().isDirty).toBe(true);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("cancels the submission in flight", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () =>
							reject(new DOMException("aborted", "AbortError")),
						);
					}),
			),
		);
		const form = createForm({ q: "" });
		const onCancel = vi.fn();
		const submitted = form.post("/search", { onCancel });
		await vi.waitFor(() => expect(form.getSnapshot().processing).toBe(true));
		form.cancel();
		await submitted;
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(form.getSnapshot().processing).toBe(false);
	});

	it("remembers its data and errors in history under its key", () => {
		const first = createForm({ draft: "" }, { rememberKey: "Post" });
		first.setData("draft", "hello");
		first.setError("draft", "too short");
		const again = createForm({ draft: "" }, { rememberKey: "Post" });
		expect(again.getSnapshot().data).toEqual({ draft: "hello" });
		expect(again.getSnapshot().errors).toEqual({ draft: "too short" });
		expect(router.restore("Post:data")).toEqual({ draft: "hello" });
	});
});

describe("photon/client > form elements", () => {
	it("reads bracketed field names into nested data", () => {
		const data = new FormData();
		data.append("user[name]", "Ada");
		data.append("user.role", "admin");
		data.append("tags[]", "a");
		data.append("tags[]", "b");
		data.append("rows[0][id]", "1");
		data.append("rows[1][id]", "2");
		data.append("avatar", new File([], ""));
		expect(formDataToObject(data)).toEqual({
			user: { name: "Ada", role: "admin" },
			tags: ["a", "b"],
			rows: [{ id: "1" }, { id: "2" }],
		});
	});

	it("ignores a field name that reaches for a prototype", () => {
		const data = new FormData();
		data.append("__proto__[polluted]", "yes");
		formDataToObject(data);
		expect(Reflect.get({}, "polluted")).toBeUndefined();
	});

	it("puts fields back to the defaults it was given", () => {
		const form = document.createElement("form");
		form.innerHTML = `
			<input name="email" value="a@b.c">
			<input type="checkbox" name="news" value="yes">
			<select name="plan"><option value="free">free</option><option value="pro">pro</option></select>
			<textarea name="bio">hi</textarea>`;
		document.body.append(form);
		const defaults = new FormData(form);
		const email = form.elements.namedItem("email");
		const news = form.elements.namedItem("news");
		const plan = form.elements.namedItem("plan");
		if (
			!(email instanceof HTMLInputElement) ||
			!(news instanceof HTMLInputElement)
		) {
			throw new Error("fields missing");
		}
		if (!(plan instanceof HTMLSelectElement)) throw new Error("select missing");
		email.value = "x@y.z";
		news.checked = true;
		plan.value = "pro";

		resetFormFields(form, defaults, ["email"]);
		expect(email.value).toBe("a@b.c");
		expect(news.checked).toBe(true);

		resetFormFields(form, defaults);
		expect(news.checked).toBe(false);
		expect(plan.value).toBe("free");
	});
});
