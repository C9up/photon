/**
 * The `url` a server writes into a page object for a request: the path and
 * query of what was asked for. The router requests absolute URLs, so a fetch
 * mock that echoes its argument as the page's `url` goes through this.
 */
export function servedPath(requested: string): string {
	const url = new URL(requested, "http://localhost:3000/");
	return url.pathname + url.search;
}
