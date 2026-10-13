import { Response } from "@c9up/ream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PhotonMiddleware,
	type PhotonMiddlewareContext,
} from "../../src/PhotonMiddleware.js";

/**
 * A page behind a security layer keeps that layer's headers.
 *
 * Blackhole sets its headers — and `response.nonce` — before the handler
 * runs; the handler then copies the render's headers onto the response, as
 * the docs show. Before the fix, that copy replaced the policy, the nonce,
 * the report-only mode and a DENY with Photon's own.
 */

const config = {
	framework: "react" as const,
	entryClient: "resources/app.tsx",
};

const POLICY =
	"default-src 'self'; script-src 'nonce-r4nd0m' 'strict-dynamic'; report-uri /csp";

/** The middleware's context, plus the per-request store blackhole fills. */
type PageContext = PhotonMiddlewareContext & { store: Map<string, unknown> };

function makeCtx(store = new Map<string, unknown>()): {
	ctx: PageContext;
	response: Response;
} {
	const response = new Response();
	const ctx: PageContext = {
		request: {
			method: () => "GET",
			path: () => "/",
			header: (_name: string): string | undefined => undefined,
		},
		response,
		store,
	};
	return { ctx, response };
}

/** The handler of the docs: render, copy every header, send. */
async function renderPage(ctx: PageContext, response: Response): Promise<void> {
	const mw = new PhotonMiddleware(config).middleware();
	await mw(ctx, async () => {
		const result = await ctx.photon?.render("Home", {});
		if (!result) throw new Error("no render");
		response.status(result.status);
		for (const [k, v] of Object.entries(result.headers)) response.header(k, v);
		response.send(result.html);
	});
}

describe("photon > pages behind a security layer", () => {
	const orig = process.env.NODE_ENV;
	beforeEach(() => {
		process.env.NODE_ENV = "development";
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = orig;
	});

	it("keeps the layer's policy, frame option and nosniff", async () => {
		const { ctx, response } = makeCtx();
		response.header("content-security-policy", POLICY);
		response.header("x-frame-options", "DENY");
		response.header("x-content-type-options", "nosniff");
		await renderPage(ctx, response);
		expect(response.getHeader("content-security-policy")).toBe(POLICY);
		expect(response.getHeader("x-frame-options")).toBe("DENY");
		expect(response.getHeader("x-content-type-options")).toBe("nosniff");
	});

	it("adds no enforced policy to a report-only one", async () => {
		const { ctx, response } = makeCtx();
		response.header("content-security-policy-report-only", POLICY);
		await renderPage(ctx, response);
		expect(response.getHeader("content-security-policy-report-only")).toBe(
			POLICY,
		);
		expect(response.getHeader("content-security-policy")).toBeUndefined();
	});

	it("leaves out the headers the layer chose to leave out", async () => {
		// frameOptions: false and noSniff: false — only the policy is set.
		const { ctx, response } = makeCtx();
		response.header("content-security-policy", POLICY);
		await renderPage(ctx, response);
		expect(response.getHeader("x-frame-options")).toBeUndefined();
		expect(response.getHeader("x-content-type-options")).toBeUndefined();
	});

	it("falls back to its own headers when no layer set any", async () => {
		const { ctx, response } = makeCtx();
		await renderPage(ctx, response);
		expect(response.getHeader("content-security-policy")).toContain(
			"default-src 'self'",
		);
		expect(response.getHeader("x-frame-options")).toBe("SAMEORIGIN");
		expect(response.getHeader("x-content-type-options")).toBe("nosniff");
		expect(response.getBody()).not.toContain("nonce=");
	});

	it("stamps the request's nonce on every script it writes", async () => {
		const { ctx, response } = makeCtx();
		response.header("content-security-policy", POLICY);
		response.nonce = "r4nd0m";
		await renderPage(ctx, response);
		const scripts = response.getBody().match(/<script\b[^>]*>/g) ?? [];
		// The page data, Vite's client and the entry.
		expect(scripts.length).toBe(3);
		for (const tag of scripts) expect(tag).toContain('nonce="r4nd0m"');
	});

	it("reads the nonce from the request store when the response has none", async () => {
		const { ctx, response } = makeCtx(new Map([["cspNonce", "fr0m-st0re"]]));
		await renderPage(ctx, response);
		const scripts = response.getBody().match(/<script\b[^>]*>/g) ?? [];
		for (const tag of scripts) expect(tag).toContain('nonce="fr0m-st0re"');
	});

	it("escapes the nonce in the attribute", async () => {
		const { ctx, response } = makeCtx();
		response.nonce = 'x"><script>alert(1)</script>';
		await renderPage(ctx, response);
		expect(response.getBody()).toContain(
			'nonce="x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"',
		);
		expect(response.getBody()).not.toContain("<script>alert(1)");
	});
});
