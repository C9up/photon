import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PhotonError } from "../../src/errors.js";
import { type PhotonConfig, PhotonRenderer } from "../../src/PhotonRenderer.js";

const baseConfig: PhotonConfig = {
	framework: "react",
	entryClient: "resources/app.tsx",
	entryServer: "resources/ssr.tsx",
};

/**
 * Catch a thrown error from a promise — preserves the original via the
 * diagnostic message so test failures don't lose context. Throws a fresh
 * Error with `String(err)` baked in if the shape is unexpected, instead of
 * a bare type string.
 */
async function expectPhotonError(
	p: Promise<unknown>,
	context: string,
): Promise<PhotonError> {
	const err = await p.then(
		() => null,
		(e: unknown) => e,
	);
	if (!(err instanceof PhotonError)) {
		const detail = err === null ? "no throw (resolved)" : String(err);
		throw new Error(`${context}: expected PhotonError, got ${detail}`);
	}
	return err;
}

describe("photon > PhotonRenderer > prod-mode manifest precheck", () => {
	const origEnv = process.env.NODE_ENV;
	let cwd: string;
	let prevCwd: string;

	beforeEach(async () => {
		process.env.NODE_ENV = "production";
		cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "photon-manifest-"));
		prevCwd = process.cwd();
		process.chdir(cwd);
	});

	afterEach(async () => {
		process.chdir(prevCwd);
		await fsp.rm(cwd, { recursive: true, force: true });
		if (origEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = origEnv;
	});

	it("throws E_PHOTON_MANIFEST_MISSING with manifestPath context when manifest.json is absent", async () => {
		// buildDir exists but contains no manifest.json — the most common
		// "build never ran for this deployment" failure mode.
		await fsp.mkdir(path.join(cwd, "public/build"), { recursive: true });
		const r = new PhotonRenderer(baseConfig);

		const err = await expectPhotonError(r.boot(), "missing-manifest precheck");
		expect(err.code).toBe("E_PHOTON_MANIFEST_MISSING");
		// Both manifest locations are probed: Vite 5+ writes
		// `<outDir>/.vite/manifest.json`, older Vite the flat `manifest.json`.
		expect(err.context).toEqual({
			manifestCandidates: [
				path.join(cwd, "public/build", ".vite", "manifest.json"),
				path.join(cwd, "public/build", "manifest.json"),
			],
			buildDir: path.join(cwd, "public/build"),
		});
		// docsUrl must point at the matching anchor — operators jump from the
		// terminal directly to the recovery page.
		expect(err.docsUrl).toBe(
			"https://ream.dev/errors/#photon-manifest-missing",
		);
		// The underlying syscall error must be forwarded as `cause` so EACCES
		// vs ENOENT is recoverable from the log without re-running.
		expect(err.cause).toBeInstanceOf(Error);
	});

	it("regression: manifest present but SSR entry missing still throws E_PHOTON_SSR_LOAD_FAILED", async () => {
		// Counter-test for the split: writing a manifest passes the precheck,
		// after which the missing SSR entry triggers the original load failure.
		// Without this guard the new precheck could over-fire and swallow real
		// SSR_LOAD_FAILED conditions.
		const buildDir = path.join(cwd, "public/build");
		await fsp.mkdir(buildDir, { recursive: true });
		await fsp.writeFile(
			path.join(buildDir, "manifest.json"),
			JSON.stringify({}),
			"utf8",
		);

		const r = new PhotonRenderer(baseConfig);
		const err = await expectPhotonError(
			r.boot(),
			"present-manifest + absent-SSR",
		);
		expect(err.code).toBe("E_PHOTON_SSR_LOAD_FAILED");
	});

	it("regression: an SSR bundle that throws at import preserves the real error as cause", async () => {
		// Before the fix the import error was swallowed (empty catch) and
		// reported as the generic "not found or missing render()", losing the
		// stack. A bundle that exists but throws at import time (syntax error,
		// throwing transitive dep, throwing side-effect) must surface its real
		// cause (audit 2026-06-13).
		const buildDir = path.join(cwd, "public/build");
		const ssrDir = path.join(cwd, "build/ssr");
		await fsp.mkdir(buildDir, { recursive: true });
		await fsp.mkdir(ssrDir, { recursive: true });
		await fsp.writeFile(
			path.join(ssrDir, "ssr.js"),
			"throw new Error('boom from ssr bundle');\nexport function render() { return ''; }",
			"utf8",
		);
		await fsp.writeFile(
			path.join(buildDir, "manifest.json"),
			JSON.stringify({}),
			"utf8",
		);

		const r = new PhotonRenderer(baseConfig);
		const err = await expectPhotonError(
			r.boot(),
			"SSR bundle throws at import",
		);
		expect(err.code).toBe("E_PHOTON_SSR_LOAD_FAILED");
		expect(err.message).toContain("threw while importing");
		expect(err.cause).toBeInstanceOf(Error);
		if (err.cause instanceof Error) {
			expect(err.cause.message).toContain("boom from ssr bundle");
		}
	});

	/** A built app: the SSR bundle where it belongs, and `manifest` as given. */
	async function writeBuild(manifest: string): Promise<string> {
		const buildDir = path.join(cwd, "public/build");
		const ssrDir = path.join(cwd, "build/ssr");
		await fsp.mkdir(path.join(buildDir, ".vite"), { recursive: true });
		await fsp.mkdir(ssrDir, { recursive: true });
		await fsp.writeFile(
			path.join(ssrDir, "ssr.js"),
			"export function render() { return ''; }",
			"utf8",
		);
		const manifestPath = path.join(buildDir, ".vite", "manifest.json");
		await fsp.writeFile(manifestPath, manifest, "utf8");
		return manifestPath;
	}

	it("fails the boot on a manifest that is there but not valid", async () => {
		// It used to be skipped with a warning, and every page then pointed at a
		// client.js the build never wrote — a healthy-looking server whose pages
		// never hydrated.
		for (const manifest of ["not valid json {", "[]", "null"]) {
			const manifestPath = await writeBuild(manifest);
			const err = await expectPhotonError(
				new PhotonRenderer(baseConfig).boot(),
				`manifest ${manifest}`,
			);
			expect(err.code).toBe("E_PHOTON_MANIFEST_INVALID");
			expect(err.message).toContain(manifestPath);
		}
	});

	it("serves the assets from /build, the URL the static server gives public/build", async () => {
		await writeBuild(
			JSON.stringify({
				"resources/app.tsx": {
					file: "assets/app-1.js",
					css: ["assets/app-1.css"],
					isEntry: true,
				},
			}),
		);
		const r = new PhotonRenderer(baseConfig);
		await r.boot();
		const { html } = await r.render("Home", {}, "/");
		expect(html).toContain('src="/build/assets/app-1.js"');
		expect(html).toContain('href="/build/assets/app-1.css"');
		expect(html).not.toContain("/public/");

		const cdn = new PhotonRenderer({
			...baseConfig,
			assetsUrl: "https://cdn.example/app/",
		});
		await cdn.boot();
		expect((await cdn.render("Home", {}, "/")).html).toContain(
			'src="https://cdn.example/app/assets/app-1.js"',
		);
	});

	it("refuses an SSR bundle anywhere the static server would serve it", async () => {
		await writeBuild("{}");
		for (const ssrBuildDir of ["public/build/ssr", "public/ssr"]) {
			const err = await expectPhotonError(
				new PhotonRenderer({ ...baseConfig, ssrBuildDir }).boot(),
				ssrBuildDir,
			);
			expect(err.code).toBe("E_PHOTON_INVALID_CONFIG");
			expect(err.message).toContain("ssrBuildDir must not be inside");
		}
	});

	it("refuses an assetsUrl that names another host by its path", async () => {
		await writeBuild("{}");
		const err = await expectPhotonError(
			new PhotonRenderer({ ...baseConfig, assetsUrl: "//evil.example" }).boot(),
			"protocol-relative assetsUrl",
		);
		expect(err.code).toBe("E_PHOTON_INVALID_CONFIG");
	});
});
