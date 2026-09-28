// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearHistoryKey,
	readHistoryState,
	toHistoryState,
} from "../../../src/client/history.js";
import type { PhotonPageData } from "../../../src/client/hydrate.js";

function page(extra: Partial<PhotonPageData> = {}): PhotonPageData {
	return {
		component: "Account",
		props: { iban: "CH93 0076 2011 6238 5295 7" },
		url: "/account",
		framework: "react",
		...extra,
	};
}

beforeEach(() => {
	sessionStorage.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
	sessionStorage.clear();
});

describe("photon/client > history state", () => {
	it("stores an ordinary page as it is", async () => {
		const state = await toHistoryState(page());
		expect(state).toEqual({ photonData: page() });
		expect(await readHistoryState(state)).toEqual(page());
	});

	it("encrypts a page that asks for it, and reads it back", async () => {
		const secret = page({ encryptHistory: true });
		const state = await toHistoryState(secret);
		expect("photonEncrypted" in state).toBe(true);
		expect(JSON.stringify(state)).not.toContain("CH93");
		expect(await readHistoryState(state)).toEqual(secret);
	});

	it("never repeats an IV under the same key", async () => {
		const first = await toHistoryState(page({ encryptHistory: true }));
		const second = await toHistoryState(page({ encryptHistory: true }));
		if (!("photonEncrypted" in first) || !("photonEncrypted" in second)) {
			throw new Error("expected two encrypted states");
		}
		expect(Array.from(first.photonEncrypted.iv)).not.toEqual(
			Array.from(second.photonEncrypted.iv),
		);
	});

	it("makes every earlier entry unreadable once history is cleared", async () => {
		const before = await toHistoryState(page({ encryptHistory: true }));
		const logout = await toHistoryState(
			page({ component: "Login", props: {}, clearHistory: true }),
		);
		expect(await readHistoryState(before)).toBeUndefined();
		expect(await readHistoryState(logout)).toEqual(
			page({ component: "Login", props: {}, clearHistory: true }),
		);

		const again = await toHistoryState(page({ encryptHistory: true }));
		clearHistoryKey();
		expect(await readHistoryState(again)).toBeUndefined();
	});

	it("stores nothing, rather than the clear page, without Web Crypto", async () => {
		vi.stubGlobal("crypto", {
			getRandomValues: (a: Uint8Array) => a,
			subtle: undefined,
		});
		const state = await toHistoryState(page({ encryptHistory: true }));
		expect(state).toEqual({ photonWithheld: true });
		expect(await readHistoryState(state)).toBeUndefined();
	});

	it("rejects a state that only looks encrypted", async () => {
		expect(
			await readHistoryState({ photonEncrypted: { iv: [1], data: "x" } }),
		).toBeUndefined();
		expect(await readHistoryState({ other: 1 })).toBeUndefined();
		expect(await readHistoryState(null)).toBeUndefined();
	});
});
