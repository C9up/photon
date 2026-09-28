// @vitest-environment jsdom

/**
 * `useForm` and `<Form>` from `@c9up/photon/react` and `/vue`, against the
 * real frameworks: a bound field submits what was typed, the page's errors
 * reach the form, and `<Form>` reads its data from its own fields.
 */

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import {
	type FormProps,
	Form as ReactForm,
	useForm as useReactForm,
} from "../../../src/client/react/index.js";
import { bootRouter } from "../../../src/client/router.js";
import {
	useForm as createVueForm,
	Form as VueForm,
} from "../../../src/client/vue/index.js";

beforeAll(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

let root: Root | undefined;
let unmountVue: (() => void) | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

function page(props: Record<string, unknown>): Response {
	return new Response(
		JSON.stringify({ component: "Page", framework: "react", url: "/", props }),
		{ headers: { "content-type": "application/json" } },
	);
}

beforeEach(() => {
	fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
		page(
			typeof init?.body === "string" && init.body.includes('"email":""')
				? { errors: { email: "required" } }
				: {},
		),
	);
	vi.stubGlobal("fetch", fetchMock);
	bootRouter({
		target: document.body,
		adapter: { update() {}, unmount() {} },
		resolveComponent: async () => ({ default: "Page" }),
		page: { component: "Page", framework: "react", url: "/", props: {} },
	});
});

afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	unmountVue?.();
	unmountVue = undefined;
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

async function until(ready: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (ready()) return;
		await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
	}
	throw new Error(`never: ${what}`);
}

function renderReact(element: ReturnType<typeof createElement>): HTMLElement {
	const target = document.createElement("div");
	document.body.append(target);
	const reactRoot = createRoot(target);
	root = reactRoot;
	act(() => reactRoot.render(element));
	return target;
}

function type(input: HTMLInputElement | null, value: string): void {
	if (!input) throw new Error("no input");
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("photon/react > useForm", () => {
	function Signup(): ReactNode {
		const form = useReactForm({ email: "" });
		return createElement(
			"div",
			null,
			createElement("input", {
				value: form.data.email,
				onChange: (event: { target: { value: string } }) =>
					form.setData("email", event.target.value),
			}),
			createElement(
				"button",
				{ type: "button", onClick: () => void form.post("/signup") },
				"go",
			),
			createElement(
				"p",
				null,
				`${form.errors.email ?? ""}|${form.isDirty ? "dirty" : "clean"}`,
			),
		);
	}

	it("shows the page's errors, then submits what was typed", async () => {
		const target = renderReact(createElement(Signup));
		await act(async () => target.querySelector("button")?.click());
		await until(
			() => target.textContent?.includes("required") ?? false,
			"the error",
		);

		act(() => type(target.querySelector("input"), "a@b.c"));
		await until(() => target.textContent?.includes("dirty") ?? false, "dirty");
		await act(async () => target.querySelector("button")?.click());
		await until(
			() => target.querySelector("p")?.textContent === "|clean",
			"a clean success",
		);
		expect(fetchMock.mock.calls[1]?.[1]?.body).toBe('{"email":"a@b.c"}');
	});
});

describe("photon/react > Form", () => {
	it("submits its own fields and hands its children the errors", async () => {
		const props: FormProps = {
			action: "/signup",
			method: "post",
			children: (form) =>
				createElement(
					"div",
					null,
					createElement("input", { name: "email", defaultValue: "" }),
					createElement("button", { type: "submit" }, "go"),
					createElement(
						"p",
						null,
						`${form.errors.email ?? ""}|${form.isDirty ? "dirty" : "clean"}`,
					),
				),
		};
		const target = renderReact(createElement(ReactForm, props));
		await act(async () => target.querySelector("button")?.click());
		await until(
			() => target.textContent?.includes("required") ?? false,
			"the error",
		);

		act(() => type(target.querySelector("input"), "a@b.c"));
		await until(() => target.textContent?.includes("dirty") ?? false, "dirty");
		await act(async () => target.querySelector("button")?.click());
		await until(
			() => !(target.textContent?.includes("required") ?? true),
			"no error",
		);
		expect(fetchMock.mock.calls[1]?.[1]?.body).toBe('{"email":"a@b.c"}');
	});
});

describe("photon/vue > useForm and Form", () => {
	function mount(component: ReturnType<typeof defineComponent>): HTMLElement {
		const target = document.createElement("div");
		document.body.append(target);
		const app = createApp(component);
		app.mount(target);
		unmountVue = () => app.unmount();
		return target;
	}

	it("binds fields at the top level and submits them", async () => {
		const Signup = defineComponent({
			setup() {
				const form = createVueForm({ email: "" });
				return () =>
					h("div", [
						h("input", {
							value: form.email,
							onInput: (event: Event) => {
								if (event.target instanceof HTMLInputElement)
									form.email = event.target.value;
							},
						}),
						h(
							"button",
							{ type: "button", onClick: () => void form.post("/signup") },
							"go",
						),
						h(
							"p",
							`${form.errors.email ?? ""}|${form.isDirty ? "dirty" : "clean"}`,
						),
					]);
			},
		});
		const target = mount(Signup);
		target.querySelector("button")?.click();
		await until(
			() => target.textContent?.includes("required") ?? false,
			"the error",
		);
		type(target.querySelector("input"), "a@b.c");
		await nextTick();
		expect(target.textContent).toContain("dirty");
		target.querySelector("button")?.click();
		await until(
			() => target.querySelector("p")?.textContent === "|clean",
			"a clean success",
		);
		expect(fetchMock.mock.calls[1]?.[1]?.body).toBe('{"email":"a@b.c"}');
	});

	it("<Form> submits its own fields and hands its slot the errors", async () => {
		const Page = defineComponent({
			setup() {
				return () =>
					h(
						VueForm,
						{ action: "/signup", method: "post" },
						{
							default: (form: { errors: Record<string, string> }) => [
								h("input", { name: "email", value: "" }),
								h("button", { type: "submit" }, "go"),
								h("p", form.errors.email ?? ""),
							],
						},
					);
			},
		});
		const target = mount(Page);
		target.querySelector("button")?.click();
		await until(
			() => target.textContent?.includes("required") ?? false,
			"the error",
		);
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
	});
});
