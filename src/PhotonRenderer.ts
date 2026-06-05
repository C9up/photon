/**
 * Photon Renderer — SSR + client hydration for React/Vue/Svelte.
 *
 * @implements FR89, FR90, FR91, FR93
 */

import { access, readFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { PhotonError } from "./errors.js";
import { type MetaTags, mergeMeta, serializeMetaTags } from "./seo/Meta.js";

export type Framework = "react" | "vue" | "svelte";

export interface PhotonConfig {
	/** Frontend framework. */
	framework: Framework;
	/** Path to the frontend entry point (e.g., 'resources/app.tsx'). */
	entryClient: string;
	/** Path to the SSR entry point (e.g., 'resources/ssr.tsx'). */
	entryServer: string;
	/** Build output directory (default: 'public/build'). */
	buildDir?: string;
	/** Vite dev server URL (default: 'http://localhost:5173'). */
	viteDevUrl?: string;
	/**
	 * Application-wide default `<head>` metadata. Per-route values
	 * (decorator / `ctx.photon.meta()` / explicit `render()` arg) merge
	 * on top — last wins per leaf field.
	 */
	defaultMeta?: MetaTags;
}

export interface PageProps {
	component: string;
	props: Record<string, unknown>;
	url: string;
	/**
	 * Frontend framework that hydrates this page on the client.
	 * Mirrors `PhotonConfig.framework`; embedded in the page-data block so
	 * `@c9up/photon/client` can dispatch to the correct adapter without an
	 * out-of-band config call.
	 */
	framework: Framework;
}

export interface RenderResult {
	/** The full HTML string to send as response. */
	html: string;
	/** HTTP status code (default: 200). */
	status: number;
	/** HTTP headers to set. */
	headers: Record<string, string>;
}

interface ViteManifestEntry {
	file?: string;
	css?: string[];
	imports?: string[];
}

/**
 * Photon Renderer — handles SSR and page data serialization.
 */
export class PhotonRenderer {
	private config: PhotonConfig;
	private ssrModule?: { render: (page: PageProps) => Promise<string> | string };
	private manifest?: Record<string, ViteManifestEntry | string[]>;
	private isDev: boolean;
	private viteOrigin?: string;

	constructor(config: PhotonConfig) {
		this.config = config;
		this.isDev = process.env.NODE_ENV !== "production";
		if (this.isDev) {
			this.viteOrigin = getSafeOrigin(
				this.config.viteDevUrl ?? "http://localhost:5173",
			);
		}
	}

	/**
	 * Initialize the renderer — load SSR module and manifest.
	 */
	async boot(): Promise<void> {
		if (this.isDev) {
			// In dev mode, SSR module is loaded via Vite's ssrLoadModule
			// This is handled by the middleware proxying to Vite
			return;
		}

		// Production: load the built SSR module and manifest
		try {
			const projectRoot = path.resolve(process.cwd());
			const buildDir = this.config.buildDir ?? "public/build";
			// Validate buildDir is within project root. `path.resolve` already
			// normalises `..` segments, but a buildDir that *equals* the project
			// root (`""`, `"."`, `"public/.."`) yields an empty relative path
			// and would silently sneak past a naive `startsWith("..")` check —
			// reject that explicitly alongside escapes and absolute paths.
			const absBuildDir = path.resolve(projectRoot, buildDir);
			const rel = path.normalize(path.relative(projectRoot, absBuildDir));
			if (
				rel === "" ||
				rel === "." ||
				rel.startsWith("..") ||
				path.isAbsolute(rel)
			) {
				throw new PhotonError(
					"PHOTON_INVALID_CONFIG",
					"buildDir must be a subdirectory of the project root",
				);
			}
			const entryPattern = /^[\w./\-@#]+\.(tsx?|jsx?|vue|svelte)$/;
			if (
				!entryPattern.test(this.config.entryServer) ||
				this.config.entryServer.split("/").includes("..")
			) {
				throw new PhotonError(
					"PHOTON_INVALID_CONFIG",
					"entryServer path is invalid or contains path traversal",
				);
			}
			if (
				!entryPattern.test(this.config.entryClient) ||
				this.config.entryClient.split("/").includes("..")
			) {
				throw new PhotonError(
					"PHOTON_INVALID_CONFIG",
					"entryClient path is invalid or contains path traversal",
				);
			}
			// Manifest precheck — distinguishes "build never ran / not deployed"
			// from "build ran but SSR entry is broken" (the post-loadSsrModule
			// failure mode below). Distinct codes give operators distinct
			// recovery instructions in the docs catalog.
			const manifestPath = path.join(absBuildDir, "manifest.json");
			try {
				await access(manifestPath);
			} catch (accessErr) {
				// Forward the syscall error so EACCES / EPERM surface in the
				// `cause` chain — the hint defaults to "missing", but the
				// real fix may be a permission flip and operators need to see
				// the underlying errno.
				throw new PhotonError(
					"PHOTON_MANIFEST_MISSING",
					`Vite manifest not accessible at ${manifestPath}.`,
					{
						hint: "Run `pnpm build` (or your project's build script) and verify your deployment ships the build output. If the file exists but the process can't read it, check filesystem permissions on the build directory.",
						context: { manifestPath, buildDir: absBuildDir },
						cause: accessErr,
					},
				);
			}
			const ssrModule = await loadSsrModule(
				absBuildDir,
				this.config.entryServer,
			);
			this.ssrModule = ssrModule;
			try {
				const manifestRaw = await readFile(manifestPath, "utf8");
				this.manifest = JSON.parse(manifestRaw) as Record<
					string,
					ViteManifestEntry | string[]
				>;
			} catch (manifestErr) {
				// Best-effort read (precheck already confirmed presence) — a
				// permission flip, concurrent rename, or malformed JSON between
				// check and read degrades to "no asset preload" rather than a
				// hard boot failure. Warn loudly so the silent degradation is
				// observable in production logs (Adonis convention: never
				// swallow without telling someone).
				console.warn(
					`[photon] manifest at ${manifestPath} could not be read after the access precheck — asset preloading disabled for this boot. ${manifestErr instanceof Error ? manifestErr.message : String(manifestErr)}`,
				);
			}
		} catch (err) {
			// Re-throw structured PhotonError instances unchanged so callers
			// see the precise code (INVALID_CONFIG / MANIFEST_MISSING) instead
			// of every prod-boot failure collapsing into SSR_LOAD_FAILED.
			// Cross-realm fallback: if a duplicated `@c9up/photon` copy in the
			// SSR bundle (workspace dep duplication, worker thread, vm context)
			// throws its own PhotonError, the `instanceof` check fails despite
			// the same shape — duck-type on the prefixed `code` field as a
			// belt-and-suspenders second guard.
			if (err instanceof PhotonError || isPhotonErrorShaped(err)) throw err;
			throw new PhotonError(
				"PHOTON_SSR_LOAD_FAILED",
				`Failed to load SSR module: ${err instanceof Error ? err.message : String(err)}`,
				{
					hint: "Run `ream build` first to generate the SSR bundle.",
					cause: err,
				},
			);
		}
	}

	/**
	 * Render a page with SSR.
	 *
	 * First request: returns full HTML (SSR + hydration script).
	 * Subsequent navigation (X-Photon header): returns JSON props only.
	 */
	async render(
		component: string,
		props: Record<string, unknown> = {},
		url: string,
		meta?: MetaTags,
	): Promise<RenderResult> {
		const pageData: PageProps = {
			component,
			props,
			url,
			framework: this.config.framework,
		};

		// SPA-mode: return JSON props for client-side navigation
		// (detected by X-Photon request header, set by the client-side router)

		// SSR mode: render full HTML
		let ssrHtml = "";
		if (this.ssrModule) {
			try {
				ssrHtml = await this.ssrModule.render(pageData);
			} catch (err) {
				// Log the real error internally, give generic message to callers
				throw new PhotonError(
					"PHOTON_SSR_RENDER_FAILED",
					"Server-side rendering failed",
					{
						hint: err instanceof Error ? err.message : String(err),
						cause: err,
					},
				);
			}
			// Validate SSR output
			if (typeof ssrHtml !== "string") {
				throw new PhotonError(
					"PHOTON_SSR_RENDER_FAILED",
					"SSR module returned non-string output",
				);
			}
		}

		const pageDataJson = JSON.stringify(pageData);
		const assets = this.getAssets();
		const headTags = serializeMetaTags(
			mergeMeta(this.config.defaultMeta, meta),
		);

		const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${headTags ? `${headTags}\n  ` : ""}${assets.css.map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`).join("\n  ")}
</head>
<body>
  <div id="app">${ssrHtml}</div>
  <script type="application/json" id="photon-data">${escapeScriptJson(pageDataJson)}</script>
  ${assets.js.map((src) => `<script type="module" src="${escapeAttr(src)}"></script>`).join("\n  ")}
</body>
</html>`;

		return {
			html,
			status: 200,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"content-security-policy": this.buildCspHeader(),
				"x-content-type-options": "nosniff",
				"x-frame-options": "SAMEORIGIN",
			},
		};
	}

	/**
	 * Render props-only response for SPA navigation.
	 *
	 * The `meta` payload is the same `MetaTags` shape used for SSR head
	 * serialization, merged with `defaultMeta` so the client can apply it
	 * to `document.title` / `<meta>` tags without needing config access.
	 * Without this, `@Meta`, `ctx.photon.meta()` and `defaultMeta` would
	 * only land on the first page load; SPA navigations would leave the
	 * head stale.
	 */
	renderProps(
		component: string,
		props: Record<string, unknown>,
		url: string,
		meta?: MetaTags,
	): RenderResult {
		const finalMeta = mergeMeta(this.config.defaultMeta, meta);
		const hasMeta =
			finalMeta &&
			(finalMeta.title !== undefined ||
				finalMeta.description !== undefined ||
				finalMeta.canonical !== undefined ||
				finalMeta.robots !== undefined ||
				(finalMeta.keywords?.length ?? 0) > 0 ||
				finalMeta.og !== undefined ||
				finalMeta.twitter !== undefined ||
				(finalMeta.custom?.length ?? 0) > 0);
		return {
			html: JSON.stringify({
				component,
				props,
				url,
				framework: this.config.framework,
				...(hasMeta ? { meta: finalMeta } : {}),
			}),
			status: 200,
			headers: {
				"content-type": "application/json",
				"x-photon": "true",
			},
		};
	}

	/**
	 * Get the framework adapter name.
	 */
	getFramework(): Framework {
		return this.config.framework;
	}

	private getAssets(): { css: string[]; js: string[] } {
		if (this.isDev) {
			const viteUrl = this.viteOrigin ?? "http://localhost:5173";
			return {
				css: [],
				js: [
					`${viteUrl}/@vite/client`,
					`${viteUrl}/${this.config.entryClient}`,
				],
			};
		}

		// Production: read from manifest
		const buildDir = this.config.buildDir ?? "public/build";
		if (!this.manifest) {
			return { css: [], js: [`/${buildDir}/client.js`] };
		}

		const entry = resolveManifestEntry(this.manifest, this.config.entryClient);
		if (entry) {
			const js = collectManifestAssets(
				this.manifest,
				this.config.entryClient,
				"js",
			)
				.map((f) => `/${buildDir}/${f}`)
				.filter((u) => isSafeUrl(u) && !u.includes(".."));
			const css = collectManifestAssets(
				this.manifest,
				this.config.entryClient,
				"css",
			)
				.map((f) => `/${buildDir}/${f}`)
				.filter((u) => isSafeUrl(u) && !u.includes(".."));
			return { css, js };
		}

		// Backward-compatible fallback for older manifest shapes.
		const css = Object.entries(this.manifest)
			.filter(([key]) => key.endsWith(".css"))
			.filter(([, v]) => Array.isArray(v))
			.flatMap(([, files]) => files as string[])
			.map((f) => `/${buildDir}/${f}`)
			.filter((u) => isSafeUrl(u) && !u.includes(".."));

		const js = Object.entries(this.manifest)
			.filter(
				([key]) =>
					key.endsWith(".js") || key.endsWith(".tsx") || key.endsWith(".vue"),
			)
			.filter(([, v]) => Array.isArray(v))
			.flatMap(([, files]) => files as string[])
			.map((f) => `/${buildDir}/${f}`)
			.filter((u) => isSafeUrl(u) && !u.includes(".."));

		return { css, js };
	}

	private buildCspHeader(): string {
		if (this.isDev && this.viteOrigin) {
			return [
				"default-src 'self'",
				`script-src 'self' ${this.viteOrigin}`,
				`connect-src 'self' ${this.viteOrigin} ws: wss:`,
				`style-src 'self' ${this.viteOrigin} 'unsafe-inline'`,
				"object-src 'none'",
			].join("; ");
		}
		return "default-src 'self'; script-src 'self'; object-src 'none'";
	}
}

/**
 * Escape JSON for safe embedding in a <script type="application/json"> block.
 * Uses Unicode escapes so JSON.parse() on the client still works.
 */
function escapeScriptJson(json: string): string {
	return json.replace(/[<>&\u2028\u2029]/g, (c) => {
		switch (c) {
			case "<":
				return "\\u003c";
			case ">":
				return "\\u003e";
			case "&":
				return "\\u0026";
			case "\u2028":
				return "\\u2028";
			case "\u2029":
				return "\\u2029";
			default:
				return c;
		}
	});
}

/** Escape a string for safe use in an HTML attribute. */
function escapeAttr(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Duck-type guard for cross-realm `PhotonError` instances. When the SSR
 * bundle dynamic-imports a duplicated `@c9up/photon` (workspace dep dup,
 * worker thread, vm context), `instanceof PhotonError` returns false despite
 * matching shape. The prefixed `PHOTON_*` `code` field is the durable marker.
 */
function isPhotonErrorShaped(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	if (!("code" in err)) return false;
	const { code } = err;
	return typeof code === "string" && code.startsWith("PHOTON_");
}

/** Return true if the URL is safe for use in src/href attributes. */
function isSafeUrl(url: string): boolean {
	return (
		url.startsWith("/") ||
		url.startsWith("http://") ||
		url.startsWith("https://")
	);
}

async function loadSsrModule(
	absBuildDir: string,
	entryServer: string,
): Promise<{ render: (page: PageProps) => Promise<string> | string }> {
	const parsed = path.parse(entryServer);
	const candidates = [
		path.join(absBuildDir, "ssr", "ssr.js"),
		path.join(absBuildDir, "ssr", `${parsed.name}.js`),
	];
	const seen = new Set<string>();

	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		try {
			const mod = await import(pathToFileURL(candidate).href);
			if (mod && typeof mod.render === "function") {
				return mod as { render: (page: PageProps) => Promise<string> | string };
			}
		} catch {
			// Try next candidate.
		}
	}

	throw new PhotonError(
		"PHOTON_SSR_LOAD_FAILED",
		"SSR module not found or missing render() export",
	);
}

function getSafeOrigin(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

function normalizeManifestKey(key: string): string {
	return key.replace(/^[./]+/, "");
}

function resolveManifestEntry(
	manifest: Record<string, ViteManifestEntry | string[]>,
	entryClient: string,
): ViteManifestEntry | undefined {
	const normalized = normalizeManifestKey(entryClient);
	for (const [key, value] of Object.entries(manifest)) {
		if (normalizeManifestKey(key) === normalized && !Array.isArray(value)) {
			return value;
		}
	}
	return undefined;
}

function collectManifestAssets(
	manifest: Record<string, ViteManifestEntry | string[]>,
	entryClient: string,
	type: "js" | "css",
): string[] {
	const out: string[] = [];
	const visited = new Set<string>();

	const visit = (key: string): void => {
		const match = Object.entries(manifest).find(
			([k]) => normalizeManifestKey(k) === normalizeManifestKey(key),
		);
		if (!match) return;
		const [actualKey, value] = match;
		if (visited.has(actualKey) || Array.isArray(value)) return;
		visited.add(actualKey);

		if (type === "js") {
			if (value.file) out.push(value.file);
		} else {
			out.push(...(value.css ?? []));
		}
		for (const imp of value.imports ?? []) visit(imp);
	};

	visit(entryClient);
	return [...new Set(out)];
}
