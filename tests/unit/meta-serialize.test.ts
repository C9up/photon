import { describe, expect, it } from "vitest";
import { serializeMetaTags } from "../../src/seo/Meta.js";

describe("photon > seo > serializeMetaTags > scalars", () => {
	it("returns an empty string when meta is undefined", () => {
		expect(serializeMetaTags(undefined)).toBe("");
	});

	it("returns an empty string when every field is undefined / empty", () => {
		expect(serializeMetaTags({})).toBe("");
		expect(serializeMetaTags({ title: "" })).toBe("");
	});

	it("emits a `<title>` from the title field", () => {
		expect(serializeMetaTags({ title: "Home" })).toBe("<title>Home</title>");
	});

	it('emits `<meta name="description">` from the description field', () => {
		expect(serializeMetaTags({ description: "Welcome" })).toBe(
			'<meta name="description" content="Welcome">',
		);
	});

	it('emits `<link rel="canonical">` from the canonical field', () => {
		expect(serializeMetaTags({ canonical: "https://example.com/x" })).toBe(
			'<link rel="canonical" href="https://example.com/x">',
		);
	});

	it('emits `<meta name="robots">` from the robots field', () => {
		expect(serializeMetaTags({ robots: "noindex,nofollow" })).toBe(
			'<meta name="robots" content="noindex,nofollow">',
		);
	});

	it("joins keywords with `, ` and emits a single meta tag", () => {
		expect(serializeMetaTags({ keywords: ["framework", "node", "ssr"] })).toBe(
			'<meta name="keywords" content="framework, node, ssr">',
		);
	});

	it("omits keywords entirely when the array is empty", () => {
		expect(serializeMetaTags({ keywords: [] })).toBe("");
	});
});

describe("photon > seo > serializeMetaTags > Open Graph", () => {
	it("expands every og:* field with `property=` (NOT `name=`)", () => {
		const out = serializeMetaTags({
			og: {
				title: "T",
				description: "D",
				image: "https://example.com/i.png",
				imageAlt: "alt",
				url: "https://example.com",
				type: "website",
				siteName: "Example",
				locale: "en_US",
			},
		});
		expect(out).toContain('<meta property="og:title" content="T">');
		expect(out).toContain('<meta property="og:description" content="D">');
		expect(out).toContain(
			'<meta property="og:image" content="https://example.com/i.png">',
		);
		expect(out).toContain('<meta property="og:image:alt" content="alt">');
		expect(out).toContain(
			'<meta property="og:url" content="https://example.com">',
		);
		expect(out).toContain('<meta property="og:type" content="website">');
		expect(out).toContain('<meta property="og:site_name" content="Example">');
		expect(out).toContain('<meta property="og:locale" content="en_US">');
		// Negative — must not produce `name="og:..."`.
		expect(out).not.toContain('name="og:');
	});

	it("emits only the og:* fields that are set, omits the rest", () => {
		const out = serializeMetaTags({ og: { title: "X" } });
		expect(out).toBe('<meta property="og:title" content="X">');
	});
});

describe("photon > seo > serializeMetaTags > Twitter Cards", () => {
	it("uses `name=` for twitter:* (NOT `property=`) per spec", () => {
		const out = serializeMetaTags({
			twitter: {
				card: "summary_large_image",
				site: "@example",
				creator: "@kaen",
				title: "T",
				description: "D",
				image: "https://example.com/i.png",
				imageAlt: "alt",
			},
		});
		expect(out).toContain(
			'<meta name="twitter:card" content="summary_large_image">',
		);
		expect(out).toContain('<meta name="twitter:site" content="@example">');
		expect(out).toContain('<meta name="twitter:creator" content="@kaen">');
		expect(out).toContain('<meta name="twitter:title" content="T">');
		expect(out).not.toContain('property="twitter:');
	});
});

describe("photon > seo > serializeMetaTags > custom tags", () => {
	it("emits a custom tag with `name`", () => {
		expect(
			serializeMetaTags({
				custom: [{ name: "theme-color", content: "#0a0a0a" }],
			}),
		).toBe('<meta name="theme-color" content="#0a0a0a">');
	});

	it("emits a custom tag with `property`", () => {
		expect(
			serializeMetaTags({
				custom: [{ property: "fb:app_id", content: "1234" }],
			}),
		).toBe('<meta property="fb:app_id" content="1234">');
	});

	it("emits a custom tag with `http-equiv`", () => {
		expect(
			serializeMetaTags({
				custom: [{ httpEquiv: "X-UA-Compatible", content: "IE=edge" }],
			}),
		).toBe('<meta http-equiv="X-UA-Compatible" content="IE=edge">');
	});

	it("emits a custom tag with `charset` only", () => {
		expect(serializeMetaTags({ custom: [{ charset: "UTF-8" }] })).toBe(
			'<meta charset="UTF-8">',
		);
	});
});

describe("photon > seo > serializeMetaTags > XSS safety", () => {
	it("escapes <, >, &, \", ' inside `<title>`", () => {
		const out = serializeMetaTags({
			title: '<script>alert("xss")</script>',
		});
		expect(out).not.toContain("<script>");
		expect(out).toContain("&lt;script&gt;");
		expect(out).toContain("&quot;xss&quot;");
	});

	it("escapes hostile content in description / og:image / canonical", () => {
		const out = serializeMetaTags({
			description: 'a"b<c>d&e',
			og: { image: 'https://example.com/x.png?q="<x>' },
			canonical: "https://example.com/x?a=&b=<",
		});
		expect(out).toContain("a&quot;b&lt;c&gt;d&amp;e");
		expect(out).toContain("&quot;&lt;x&gt;");
		expect(out).toContain("a=&amp;b=&lt;");
		// Per-line check: no `<meta>`/`<link>` line carries an unescaped raw
		// quote inside its content/href value (would split the attribute).
		for (const line of out.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("<meta") && !trimmed.startsWith("<link"))
				continue;
			// Strip the closing `>` then count quotes — must be even
			// (well-formed pair-of-attribute structure).
			const body = trimmed.replace(/>$/, "");
			const quoteCount = (body.match(/"/g) ?? []).length;
			expect(quoteCount % 2).toBe(0);
		}
	});

	it('escapes a malicious `" onerror=alert(1)` payload in attributes', () => {
		const out = serializeMetaTags({
			twitter: { image: '" onerror="alert(1)' },
		});
		// The raw payload would produce an attribute injection if unescaped.
		expect(out).not.toContain('onerror="alert');
		expect(out).toContain("&quot; onerror=&quot;alert(1)");
	});
});
