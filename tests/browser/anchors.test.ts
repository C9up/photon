import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { PhotonPageData } from "../../src/client/hydrate.js";
import { bootRouter } from "../../src/client/router.js";

/**
 * Which anchors the router follows, clicked for real in Chromium.
 *
 * A plain anchor and one marked `data-photon="external"` are left to the
 * browser: no X-Photon request, the click's default action intact. Only
 * `data-photon` makes a client visit. Letting the browser actually navigate
 * would unload the test page, so a listener on `window` — the last stop of the
 * click — records whether the default was prevented, then holds the browser
 * back itself.
 */

const MARKER = "photonAnchorsMarker";

let clicks: Array<{ href: string | null; prevented: boolean }> = [];

function holdNavigation(event: MouseEvent): void {
	const anchor =
		event.target instanceof Element ? event.target.closest("a") : null;
	clicks.push({
		href: anchor?.getAttribute("href") ?? null,
		prevented: event.defaultPrevented,
	});
	event.preventDefault();
}

function stubServer() {
	const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
		const url = new URL(input, location.href);
		return new Response(
			JSON.stringify({
				component: "Orders",
				framework: "react",
				url: url.pathname,
				props: { title: "Orders" },
			}),
			{
				headers: { "content-type": "application/json", "x-photon": "true" },
			},
		);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function mount(): HTMLElement {
	const target = document.createElement("div");
	const heading = document.createElement("h1");
	heading.textContent = "Home";
	target.append(heading);
	const links: Array<[string, string, string | undefined]> = [
		["plain", "/plain-page", undefined],
		["photon", "/orders", ""],
		["external", "/external-page", "external"],
	];
	for (const [label, href, photon] of links) {
		const a = document.createElement("a");
		a.href = href;
		a.textContent = label;
		a.style.display = "block";
		if (photon !== undefined) a.dataset.photon = photon;
		target.append(a);
	}
	document.body.append(target);

	const page: PhotonPageData = {
		component: "Home",
		framework: "react",
		url: location.pathname,
		props: { title: "Home" },
	};
	bootRouter({
		target,
		adapter: {
			update: (_component, props) => {
				heading.textContent = String(props.title);
			},
			unmount() {},
		},
		resolveComponent: async () => ({ default: "Page" }),
		page,
	});
	return target;
}

function link(target: HTMLElement, label: string): HTMLAnchorElement {
	const found = [...target.querySelectorAll("a")].find(
		(a) => a.textContent === label,
	);
	if (found === undefined) throw new Error(`no ${label} link`);
	return found;
}

describe("photon > anchors in a real browser", () => {
	const startPath = location.pathname;

	beforeEach(() => {
		document.body.replaceChildren();
		clicks = [];
		Reflect.set(window, MARKER, "kept");
		window.addEventListener("click", holdNavigation);
	});

	afterEach(() => {
		window.removeEventListener("click", holdNavigation);
		Reflect.deleteProperty(window, MARKER);
		vi.unstubAllGlobals();
		history.replaceState(null, "", startPath);
	});

	it("leaves a plain anchor to the browser: no X-Photon request", async () => {
		const fetchMock = stubServer();
		const target = mount();

		await userEvent.click(link(target, "plain"));
		await new Promise((r) => setTimeout(r, 50));

		expect(clicks).toEqual([{ href: "/plain-page", prevented: false }]);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(location.pathname).toBe(startPath);
	});

	it('leaves a data-photon="external" anchor to the browser', async () => {
		const fetchMock = stubServer();
		const target = mount();

		await userEvent.click(link(target, "external"));
		await new Promise((r) => setTimeout(r, 50));

		expect(clicks).toEqual([{ href: "/external-page", prevented: false }]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("visits a data-photon anchor over X-Photon, without a page load", async () => {
		const fetchMock = stubServer();
		const target = mount();

		await userEvent.click(link(target, "photon"));
		await vi.waitFor(() => {
			expect(target.querySelector("h1")?.textContent).toBe("Orders");
		});

		expect(clicks).toEqual([{ href: "/orders", prevented: true }]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const init = fetchMock.mock.calls[0]?.[1];
		expect(new Headers(init?.headers).get("x-photon")).toBe("true");
		expect(location.pathname).toBe("/orders");
		// The same document: what this window held before the click is still here.
		expect(Reflect.get(window, MARKER)).toBe("kept");
	});
});
