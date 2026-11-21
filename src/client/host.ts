/**
 * Where the client router runs: the platform's address, history, requests,
 * full loads and events.
 *
 * The protocol — what a visit asks, how a page object is applied, partial
 * reloads, deferred props, the version check — is the router's and has one
 * implementation. What differs between a browser and an app on a phone is
 * only this: a browser has `location`, `history`, `document` and a full page
 * load; a phone app has a server origin, its own back stack and no document.
 * `bootPage({ host })` hands the router another host; without one it runs on
 * the browser's.
 */

/** An event the router announces (`photon:start`, `photon:success`…). */
export interface PhotonEvent<T> {
	readonly detail: T;
}

export interface PhotonHost {
	/** The current address, absolute: what a relative URL resolves against. */
	href(): string;
	/** What a link's `href` resolves against (a `<base href>` included). */
	baseUri(): string;
	/** A request to the server, as the platform makes it. */
	fetch(url: string, init: RequestInit): Promise<Response>;
	/** The current history entry's state. */
	state(): unknown;
	/** A new history entry at `url`. */
	push(state: unknown, url: string): void;
	/** The current history entry, rewritten. */
	replace(state: unknown, url: string): void;
	/** Leave for a full load of `url`: what a stale version or a non-page answer asks. */
	load(url: string): void;
	/** A full load of the current address. */
	reload(): void;
	/**
	 * Hand a router event to the platform (`type` without the `photon:`
	 * prefix): a browser dispatches it on `document`. `router.on` listeners
	 * hear it from the router itself, whatever the host.
	 */
	emit(type: string, detail: unknown): void;
	/** A cookie the client may read (`XSRF-TOKEN`), when the platform has them. */
	cookie(name: string): string | undefined;
	/**
	 * History kept in memory only, never written anywhere: entries are stored
	 * as they are, even when a page asks for encrypted history (which guards
	 * what a browser keeps in its session history and back-forward cache).
	 */
	readonly memoryHistory: boolean;
	/**
	 * Called once, when the router starts: wire the platform's link clicks,
	 * back / forward, and a page coming back from a cache to the router.
	 */
	listen(router: {
		click(event: unknown): void;
		restore(state: unknown): void;
		resume(state: unknown): void;
	}): void;
}

/** The browser: `location`, `history`, `document` and its events, as photon always used them. */
export function browserHost(): PhotonHost {
	return {
		href: () => location.href,
		baseUri: () =>
			typeof document.baseURI === "string" ? document.baseURI : location.href,
		// Read at call time, so a stubbed or polyfilled fetch is the one used.
		fetch: (url, init) => fetch(url, init),
		state: () => history.state,
		push: (state, url) => history.pushState(state, "", url),
		replace: (state, url) => history.replaceState(state, "", url),
		load: (url) => {
			try {
				location.href = url;
			} catch {
				// jsdom's restricted `location` setter may throw.
			}
		},
		reload: () => location.reload(),
		emit: (type, detail) => {
			document.dispatchEvent(new CustomEvent(`photon:${type}`, { detail }));
		},
		cookie: (name) => {
			for (const part of document.cookie.split(";")) {
				const [key, ...rest] = part.trim().split("=");
				if (key === name) return decodeURIComponent(rest.join("="));
			}
			return undefined;
		},
		memoryHistory: false,
		listen: (router) => {
			document.addEventListener("click", (event) => router.click(event));
			window.addEventListener("popstate", (event) =>
				router.restore(event.state),
			);
			window.addEventListener("pageshow", (event) => {
				if (event.persisted) router.resume(history.state);
			});
		},
	};
}

let active: PhotonHost | undefined;

/** The host the router runs on: the one `bootPage` was given, else the browser's. */
export function currentHost(): PhotonHost | undefined {
	if (active !== undefined) return active;
	if (typeof window === "undefined" || typeof document === "undefined") {
		return undefined;
	}
	active = browserHost();
	return active;
}

/** @internal `bootPage` installs the host it was given. */
export function installHost(host: PhotonHost | undefined): void {
	if (host !== undefined) active = host;
}
