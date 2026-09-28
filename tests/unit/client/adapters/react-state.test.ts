/**
 * @vitest-environment jsdom
 *
 * The React adapter against the real React: rendering the SAME component type
 * into the root again is an update, not a remount, so a page keeps its state
 * when props arrive after it (a deferred group, a partial reload).
 */

import { act, createElement, useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { reactAdapter } from "../../../../src/client/adapters/react.js";

beforeAll(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
	document.body.replaceChildren();
});

function Counter({ label }: { label: string }) {
	const [clicks, setClicks] = useState(0);
	return createElement(
		"button",
		{ type: "button", onClick: () => setClicks((n) => n + 1) },
		`${label}:${clicks}`,
	);
}

function button(target: Element): HTMLButtonElement {
	const el = target.querySelector("button");
	if (!el) throw new Error("expected the counter's button");
	return el;
}

describe("photon/client/adapters/react > with React", () => {
	it("keeps the component's state when the same page gets new props", async () => {
		const target = document.createElement("div");
		target.innerHTML = renderToString(createElement(Counter, { label: "a" }));
		document.body.append(target);

		const handle = await act(() =>
			reactAdapter.hydrate(target, Counter, { label: "a" }),
		);
		await act(async () => {
			button(target).click();
		});
		expect(button(target).textContent).toBe("a:1");

		await act(async () => {
			handle.update(Counter, { label: "b" });
		});
		expect(button(target).textContent).toBe("b:1");
		await act(async () => handle.unmount());
	});
});
