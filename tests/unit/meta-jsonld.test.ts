import { describe, expect, it } from "vitest";
import { PhotonRenderer } from "../../src/PhotonRenderer.js";
import { mergeMeta, serializeMetaTags } from "../../src/seo/index.js";

/** The JSON of the page's JSON-LD script, read back. */
function jsonLdOf(html: string): unknown {
	const match =
		/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
	if (!match) throw new Error("no JSON-LD script");
	return JSON.parse(match[1] ?? "");
}

describe("photon > MetaTags.jsonLd", () => {
	it("writes one node with its context, Photon's own", () => {
		const html = serializeMetaTags({
			jsonLd: { "@type": "Product", name: "Anvil" },
		});
		expect(html).toContain(
			'<script type="application/ld+json" data-photon-meta="1">',
		);
		expect(jsonLdOf(html)).toEqual({
			"@context": "https://schema.org",
			"@type": "Product",
			name: "Anvil",
		});
	});

	it("writes several nodes, or a whole document, as one @graph", () => {
		const graph = {
			"@context": "https://schema.org",
			"@graph": [
				{
					"@type": "Organization",
					"@id": "https://acme.example/#identity",
					name: "ACME",
				},
				{ "@type": "WebSite", "@id": "https://acme.example/#website" },
			],
		};
		expect(jsonLdOf(serializeMetaTags({ jsonLd: graph }))).toEqual(graph);
		expect(
			jsonLdOf(
				serializeMetaTags({
					jsonLd: [
						{ "@context": "https://schema.org", "@type": "Thing", name: "a" },
						{ "@type": "Thing", name: "b" },
					],
				}),
			),
		).toEqual({
			"@context": "https://schema.org",
			"@graph": [
				{ "@type": "Thing", name: "a" },
				{ "@type": "Thing", name: "b" },
			],
		});
	});

	it("cannot be broken out of, and carries the nonce", () => {
		const html = serializeMetaTags(
			{
				jsonLd: {
					"@type": "Product",
					name: "</script><script>alert(1)</script>\u2028",
				},
			},
			{ nonce: 'r4nd"0m' },
		);
		expect(html).not.toContain("</script><script>");
		expect(html).toContain('nonce="r4nd&quot;0m"');
		expect(jsonLdOf(html)).toMatchObject({
			name: "</script><script>alert(1)</script>\u2028",
		});
	});

	it("writes nothing for no structured data", () => {
		expect(serializeMetaTags({ title: "A", jsonLd: [] })).not.toContain(
			"ld+json",
		);
		expect(serializeMetaTags({ jsonLd: JSON.parse('[1, "x", null]') })).toBe(
			"",
		);
	});

	it("merges the layers' nodes by @id: types united, the later value wins", () => {
		const layout = {
			jsonLd: [
				{
					"@type": "Organization",
					"@id": "#identity",
					name: "ACME",
					url: "https://acme.example/",
				},
				{ "@type": "Thing", name: "kept" },
			],
		};
		const page = {
			jsonLd: {
				"@context": "https://schema.org",
				"@graph": [
					{ "@type": "Store", "@id": "#identity", name: "ACME Store" },
					{ "@type": "Product", name: "Anvil" },
				],
			},
		};
		expect(mergeMeta(layout, page).jsonLd).toEqual([
			{
				"@type": ["Organization", "Store"],
				"@id": "#identity",
				name: "ACME Store",
				url: "https://acme.example/",
			},
			{ "@type": "Thing", name: "kept" },
			{ "@type": "Product", name: "Anvil" },
		]);
	});

	it("keeps an earlier node's type when the later one has none", () => {
		const merged = mergeMeta(
			{ jsonLd: { "@type": "Organization", "@id": "#o", name: "A" } },
			{ jsonLd: JSON.parse('{"@id": "#o", "telephone": "+41 32 000 00 00"}') },
		);
		expect(merged.jsonLd).toEqual([
			{
				"@type": "Organization",
				"@id": "#o",
				name: "A",
				telephone: "+41 32 000 00 00",
			},
		]);
	});
});

describe("photon > PhotonRenderer and JSON-LD", () => {
	const config = {
		framework: "react" as const,
		entryClient: "resources/app.tsx",
	};

	it("puts the page's JSON-LD in <head>, with the request's nonce", async () => {
		const original = process.env.NODE_ENV;
		process.env.NODE_ENV = "development";
		try {
			const renderer = new PhotonRenderer({
				...config,
				defaultMeta: {
					jsonLd: { "@type": "WebSite", "@id": "#website", name: "ACME" },
				},
			});
			// What blackhole leaves on the response: its nonce.
			const response = {
				status: () => undefined,
				header: () => undefined,
				send: () => {},
				getHeader: () => undefined,
				nonce: "n0nce",
			};
			const result = await renderer.render(
				"Home",
				{},
				"/",
				{ jsonLd: { "@type": "WebPage", "@id": "#webpage", name: "Home" } },
				{},
				[],
				{ response },
			);
			const head = result.html.slice(0, result.html.indexOf("</head>"));
			expect(head).toContain(
				'<script type="application/ld+json" nonce="n0nce" data-photon-meta="1">',
			);
			expect(jsonLdOf(head)).toEqual({
				"@context": "https://schema.org",
				"@graph": [
					{ "@type": "WebSite", "@id": "#website", name: "ACME" },
					{ "@type": "WebPage", "@id": "#webpage", name: "Home" },
				],
			});
		} finally {
			if (original === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = original;
		}
	});

	it("sends it with an SPA navigation's props", () => {
		const renderer = new PhotonRenderer(config);
		const result = renderer.renderProps("Home", {}, "/", {
			jsonLd: { "@type": "WebPage", name: "Home" },
		});
		expect(JSON.parse(result.html).meta).toEqual({
			jsonLd: [{ "@type": "WebPage", name: "Home" }],
		});
	});
});
