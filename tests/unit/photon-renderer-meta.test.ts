import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PhotonConfig, PhotonRenderer } from "../../src/PhotonRenderer.js";

const baseConfig: PhotonConfig = {
	framework: "react",
	entryClient: "resources/app.tsx",
	entryServer: "resources/ssr.tsx",
};

describe("photon > PhotonRenderer > head injection", () => {
	const orig = process.env.NODE_ENV;
	beforeEach(() => {
		process.env.NODE_ENV = "development";
	});
	afterEach(() => {
		if (orig === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = orig;
	});

	it("emits a `<title>` from the per-call meta argument", async () => {
		const r = new PhotonRenderer(baseConfig);
		const out = await r.render("Home", {}, "/", { title: "Hello" });
		expect(out.html).toContain("<title>Hello</title>");
	});

	it("emits og:* tags with property= and twitter:* tags with name=", async () => {
		const r = new PhotonRenderer(baseConfig);
		const out = await r.render("Home", {}, "/", {
			og: { title: "OG", image: "https://example.com/i.png" },
			twitter: { card: "summary_large_image", site: "@example" },
		});
		expect(out.html).toContain('<meta property="og:title" content="OG">');
		expect(out.html).toContain(
			'<meta property="og:image" content="https://example.com/i.png">',
		);
		expect(out.html).toContain(
			'<meta name="twitter:card" content="summary_large_image">',
		);
	});

	it("escapes XSS attempts in title and description", async () => {
		const r = new PhotonRenderer(baseConfig);
		const out = await r.render("Home", {}, "/", {
			title: "<script>alert(1)</script>",
			description: '"><script>x</script>',
		});
		// Critical: no raw <script> tag must reach the rendered head.
		const headBlock = out.html.split("</head>")[0];
		expect(headBlock).not.toContain("<script>alert");
		expect(headBlock).toContain("&lt;script&gt;alert");
		expect(headBlock).toContain("&quot;&gt;&lt;script&gt;x&lt;/script&gt;");
	});

	it("merges `defaultMeta` (config) with per-call meta, per-call wins per leaf", async () => {
		const r = new PhotonRenderer({
			...baseConfig,
			defaultMeta: {
				title: "Default Title",
				description: "Default desc",
				og: { siteName: "Example" },
			},
		});
		const out = await r.render("Home", {}, "/", {
			title: "Override Title",
			og: { image: "/i.png" },
		});
		expect(out.html).toContain("<title>Override Title</title>");
		// Description carried from defaults (not overridden).
		expect(out.html).toContain(
			'<meta name="description" content="Default desc">',
		);
		// og fields field-merged: siteName from defaults + image from call.
		expect(out.html).toContain(
			'<meta property="og:site_name" content="Example">',
		);
		expect(out.html).toContain('<meta property="og:image" content="/i.png">');
	});

	it("when no meta is provided anywhere, the head matches the legacy shape", async () => {
		const r = new PhotonRenderer(baseConfig);
		const out = await r.render("Home", {}, "/");
		const headBlock = out.html.split("</head>")[0];
		// No SEO tag should appear: head only carries charset + viewport.
		expect(headBlock).not.toMatch(/<title>/);
		expect(headBlock).not.toMatch(/<meta name="description"/);
		expect(headBlock).not.toMatch(/<meta property="og:/);
		expect(headBlock).toContain('<meta charset="UTF-8">');
		expect(headBlock).toContain('name="viewport"');
	});
});
