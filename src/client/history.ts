/// <reference lib="dom" />
// This file uses browser globals. The reference pulls the DOM lib in for
// THIS file whatever `lib` the consumer configured, so a Node app
// typechecking against our sources does not trip over `window` —
// `types: "./src/index.ts"` means every consumer reads them.
/**
 * Photon — the page kept in `history.state`, encrypted when the server asks.
 *
 * The router stores each page it shows so back and forward can render it
 * again without a request. That copy is the props, in the clear, readable by
 * anyone who opens the tab after the user has left it — which is why the
 * server can ask for `encryptHistory`, and why `clearHistory` at logout is
 * meant to make every earlier copy unreadable. The client ignored both; this
 * module is what honours them.
 *
 * The shape follows `@inertiajs/core`: AES-GCM, a 256-bit key kept in
 * `sessionStorage` so the tab's earlier entries survive a reload, and a
 * cleared history being a deleted key. Two deliberate differences:
 *
 * - A fresh random IV for every entry, stored beside it. Inertia keeps ONE IV
 *   per key, and AES-GCM under a repeated IV leaks the XOR of the plaintexts
 *   and lets the authentication key be recovered.
 * - No plaintext fallback. Without `crypto.subtle` (a page not served over
 *   HTTPS) Inertia stores the page unencrypted; Photon stores nothing, and a
 *   back navigation to that entry loads it from the server instead.
 *
 * Browser-only — strict no `node:` imports.
 */

import type { PhotonPageData } from "./hydrate.js";

const KEY_STORAGE = "photon:history-key";

/** What the router puts in `history.state`. */
export type HistoryState =
	| { photonData: PhotonPageData }
	| { photonEncrypted: { iv: Uint8Array; data: ArrayBuffer } }
	| { photonWithheld: true };

/** Whether `state` is one Photon wrote, readable or not. */
export function isPhotonState(state: unknown): boolean {
	return (
		typeof state === "object" &&
		state !== null &&
		("photonData" in state ||
			"photonEncrypted" in state ||
			"photonWithheld" in state)
	);
}

/**
 * The state to store for `page`, encrypted when the page asks for it.
 *
 * `clearHistory` deletes the key FIRST, so the page that asked for it is
 * stored under a new key and every entry before it can no longer be read.
 */
export async function toHistoryState(
	page: PhotonPageData,
): Promise<HistoryState> {
	if (page.clearHistory === true) clearHistoryKey();
	// The flash was news once; stored, the back button would replay it.
	const stored: PhotonPageData = { ...page };
	delete stored.flash;
	if (stored.encryptHistory !== true) return { photonData: stored };
	const subtle = subtleCrypto();
	if (subtle === undefined) return { photonWithheld: true };
	try {
		const key = await loadOrCreateKey(subtle);
		if (key === null) return { photonWithheld: true };
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const data = await subtle.encrypt(
			{ name: "AES-GCM", iv },
			key,
			new TextEncoder().encode(JSON.stringify(stored)),
		);
		return { photonEncrypted: { iv, data } };
	} catch {
		return { photonWithheld: true };
	}
}

/**
 * The page stored in `state`, or undefined when there is none to read: not a
 * Photon state, withheld, or encrypted under a key that is gone. The caller
 * validates what comes back — it is only as trustworthy as `history.state`.
 */
export async function readHistoryState(state: unknown): Promise<unknown> {
	if (typeof state !== "object" || state === null) return undefined;
	if ("photonData" in state) return state.photonData;
	if (!("photonEncrypted" in state)) return undefined;
	const sealed = state.photonEncrypted;
	if (typeof sealed !== "object" || sealed === null) return undefined;
	const iv = Reflect.get(sealed, "iv");
	const data = Reflect.get(sealed, "data");
	if (!isBrand(iv, "Uint8Array") || !isBrand(data, "ArrayBuffer")) {
		return undefined;
	}
	const subtle = subtleCrypto();
	if (subtle === undefined) return undefined;
	try {
		const key = await loadKey(subtle);
		if (key === null) return undefined;
		// Copied: `history.state` hands back a view over whatever buffer the
		// structured clone produced, and Web Crypto wants one it owns.
		const plain = await subtle.decrypt(
			{ name: "AES-GCM", iv: new Uint8Array(iv) },
			key,
			data,
		);
		return JSON.parse(new TextDecoder().decode(plain));
	} catch {
		return undefined;
	}
}

/**
 * Whether `value` is a `Uint8Array` / `ArrayBuffer` from ANY realm. `instanceof`
 * is per realm, and a buffer can come back from `history.state` or Web Crypto
 * built by another one — which read as "not encrypted" and dropped the entry.
 */
function isBrand(value: unknown, brand: "Uint8Array"): value is Uint8Array;
function isBrand(value: unknown, brand: "ArrayBuffer"): value is ArrayBuffer;
function isBrand(value: unknown, brand: string): boolean {
	return Object.prototype.toString.call(value) === `[object ${brand}]`;
}

/** Forget the key: every entry encrypted under it becomes unreadable. */
export function clearHistoryKey(): void {
	try {
		sessionStorage.removeItem(KEY_STORAGE);
	} catch {
		// Storage denied (privacy mode, sandbox): there is no key to remove.
	}
}

/** `crypto.subtle`, which browsers only expose in a secure context. */
function subtleCrypto(): SubtleCrypto | undefined {
	return typeof crypto !== "undefined" && crypto.subtle !== undefined
		? crypto.subtle
		: undefined;
}

async function loadKey(subtle: SubtleCrypto): Promise<CryptoKey | null> {
	let raw: unknown;
	try {
		raw = JSON.parse(sessionStorage.getItem(KEY_STORAGE) ?? "null");
	} catch {
		return null;
	}
	if (!Array.isArray(raw) || !raw.every((n) => typeof n === "number")) {
		return null;
	}
	try {
		return await subtle.importKey(
			"raw",
			new Uint8Array(raw),
			{ name: "AES-GCM" },
			false,
			["encrypt", "decrypt"],
		);
	} catch {
		return null;
	}
}

/**
 * The tab's key, created on first use. Null when it cannot be kept: a key that
 * does not survive to the next read would encrypt entries nothing can open.
 */
async function loadOrCreateKey(
	subtle: SubtleCrypto,
): Promise<CryptoKey | null> {
	const existing = await loadKey(subtle);
	if (existing !== null) return existing;
	const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
		"encrypt",
		"decrypt",
	]);
	const raw = new Uint8Array(await subtle.exportKey("raw", key));
	try {
		sessionStorage.setItem(KEY_STORAGE, JSON.stringify(Array.from(raw)));
	} catch {
		return null;
	}
	return key;
}
