import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { svelteAdapter } from "../../src/client/adapters/svelte.js";
import PhotonRoot from "../../src/client/svelte/PhotonRoot.svelte";
import Counter from "./fixtures/Counter.svelte";
import Other from "./fixtures/Other.svelte";

/**
 * The `renderSvelte` command from `vitest.browser.config.ts`, run in Node. Read
 * off `commands` and checked, rather than typed by augmenting vitest's
 * `BrowserCommands`, which its type re-export does not let through.
 */
async function renderSvelte(
	page: string,
	props: Record<string, unknown>,
): Promise<string> {
	const command: unknown = Reflect.get(commands, "renderSvelte");
	if (typeof command !== "function") throw new Error("renderSvelte missing");
	const html: unknown = await Reflect.apply(command, commands, [page, props]);
	if (typeof html !== "string")
		throw new Error("renderSvelte returned no HTML");
	return html;
}

/**
 * The Svelte adapter with Photon's root, against the real Svelte 5 compiled by
 * its Vite plugin: the server renders the root around the page, the client
 * hydrates it, and later props reach the SAME page instead of a new one.
 */

async function serverRendered(props: Record<string, unknown>) {
	const target = document.createElement("div");
	target.innerHTML = await renderSvelte("Counter", props);
	document.body.replaceChildren(target);
	return target;
}

function button(target: Element): HTMLButtonElement {
	const el = target.querySelector("button");
	if (!el) throw new Error("expected the counter's button");
	return el;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("photon/client > Svelte root in Chromium", () => {
	it("hydrates the server's markup without a mismatch", async () => {
		const warn = vi.spyOn(console, "warn");
		const target = await serverRendered({ label: "a" });
		const ssrButton = button(target);

		await svelteAdapter.hydrate(
			target,
			Counter,
			{ label: "a" },
			{
				svelteRoot: PhotonRoot,
			},
		);

		expect(button(target)).toBe(ssrButton);
		expect(warn.mock.calls.flat().join(" ")).not.toMatch(/hydrat|mismatch/i);
	});

	it("keeps the page's state when the same page gets new props", async () => {
		const target = await serverRendered({ label: "a" });
		const handle = await svelteAdapter.hydrate(
			target,
			Counter,
			{ label: "a" },
			{
				svelteRoot: PhotonRoot,
			},
		);

		button(target).click();
		await tick();
		expect(button(target).textContent).toBe("a:1");

		handle.update(Counter, { label: "b" });
		await tick();
		expect(button(target).textContent).toBe("b:1");
	});

	it("swaps in another page", async () => {
		const target = await serverRendered({ label: "a" });
		const handle = await svelteAdapter.hydrate(
			target,
			Counter,
			{ label: "a" },
			{
				svelteRoot: PhotonRoot,
			},
		);
		handle.update(Other, { label: "b" });
		await tick();
		expect(target.textContent?.trim()).toBe("other b");
	});

	it("still remounts, losing state, without the root", async () => {
		const target = document.createElement("div");
		target.innerHTML = await renderSvelte("Counter", { label: "a" });
		// Without the root the server would have rendered the page alone; mount
		// fresh to keep the comparison about updates only.
		target.replaceChildren();
		document.body.replaceChildren(target);
		const handle = await svelteAdapter.hydrate(target, Counter, { label: "a" });
		handle.update(Counter, { label: "a" });
		await tick();
		button(target).click();
		await tick();
		handle.update(Counter, { label: "b" });
		await tick();
		expect(button(target).textContent).toBe("b:0");
	});
});
