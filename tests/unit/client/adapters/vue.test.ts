/**
 * @vitest-environment jsdom
 *
 * Against the real Vue runtime, not a mock of it: what matters here is what
 * Vue does with the adapter's root — whether it hydrates the server's markup,
 * and whether a component keeps its state when new props arrive.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSSRApp, defineComponent, h, nextTick, ref } from "vue";
import { renderToString } from "vue/server-renderer";
import { vueAdapter } from "../../../../src/client/adapters/vue.js";

/** A button that counts its own clicks, labelled by a prop. */
const Counter = defineComponent({
	props: { label: { type: String, required: true } },
	setup(props) {
		const clicks = ref(0);
		return () =>
			h(
				"button",
				{ onClick: () => clicks.value++ },
				`${props.label}:${clicks.value}`,
			);
	},
});

const Other = defineComponent({
	props: { label: { type: String, required: true } },
	setup(props) {
		return () => h("p", `other ${props.label}`);
	},
});

/** `#app` holding what the server would have rendered for `props`. */
async function serverRendered(props: Record<string, unknown>) {
	const target = document.createElement("div");
	target.setAttribute("data-server-rendered", "true");
	target.innerHTML = await renderToString(createSSRApp(Counter, props));
	document.body.replaceChildren(target);
	return target;
}

function button(target: Element): HTMLButtonElement {
	const el = target.querySelector("button");
	if (!el) throw new Error("expected the counter's button");
	return el;
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("photon/client/adapters/vue", () => {
	it("hydrates the server's markup without a mismatch", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const target = await serverRendered({ label: "a" });
		const ssrButton = button(target);

		await vueAdapter.hydrate(target, Counter, { label: "a" });

		// Hydration adopts the node the server rendered instead of replacing it.
		expect(button(target)).toBe(ssrButton);
		expect(warn.mock.calls.flat().join(" ")).not.toMatch(/mismatch/i);
	});

	it("mounts an empty target, when the server rendered nothing, without a warning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const target = document.createElement("div");
		document.body.replaceChildren(target);

		await vueAdapter.hydrate(target, Counter, { label: "a" });

		expect(button(target).textContent).toBe("a:0");
		// createSSRApp on an empty target warns that it mounts instead.
		expect(warn).not.toHaveBeenCalled();
	});

	it("keeps the component's state when the same page gets new props", async () => {
		const target = await serverRendered({ label: "a" });
		const handle = await vueAdapter.hydrate(target, Counter, { label: "a" });

		button(target).click();
		await nextTick();
		expect(button(target).textContent).toBe("a:1");

		handle.update(Counter, { label: "b" });
		await nextTick();
		expect(button(target).textContent).toBe("b:1");
	});

	it("swaps in another page component", async () => {
		const target = await serverRendered({ label: "a" });
		const handle = await vueAdapter.hydrate(target, Counter, { label: "a" });

		handle.update(Other, { label: "b" });
		await nextTick();
		expect(target.textContent).toBe("other b");
	});

	it("update() after unmount() is a no-op (no resurrect into a dead target)", async () => {
		const target = await serverRendered({ label: "a" });
		const handle = await vueAdapter.hydrate(target, Counter, { label: "a" });
		handle.unmount();
		expect(target.innerHTML).toBe("");

		handle.update(Other, { label: "b" });
		await nextTick();
		expect(target.innerHTML).toBe("");
	});
});
