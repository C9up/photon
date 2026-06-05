import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	it("throws PHOTON_MANIFEST_MISSING with manifestPath context when manifest.json is absent", async () => {
		// buildDir exists but contains no manifest.json — the most common
		// "build never ran for this deployment" failure mode.
		await fsp.mkdir(path.join(cwd, "public/build"), { recursive: true });
		const r = new PhotonRenderer(baseConfig);

		const err = await expectPhotonError(r.boot(), "missing-manifest precheck");
		expect(err.code).toBe("PHOTON_MANIFEST_MISSING");
		expect(err.context).toEqual({
			manifestPath: path.join(cwd, "public/build", "manifest.json"),
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

	it("regression: manifest present but SSR entry missing still throws PHOTON_SSR_LOAD_FAILED", async () => {
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
		expect(err.code).toBe("PHOTON_SSR_LOAD_FAILED");
	});

	it("malformed manifest JSON degrades silently after warn (SSR loads, manifest readFile fails inside best-effort catch)", async () => {
		// The precheck only checks file presence, not JSON validity. With a
		// valid SSR entry on disk, `loadSsrModule` succeeds and the boot path
		// then reaches the inner readFile + JSON.parse on the manifest. A
		// corrupt manifest passes `fs.access` but `JSON.parse` throws inside
		// the inner best-effort catch. Documented contract: asset preloading
		// silently disabled + console.warn surfaced + boot completes.
		const buildDir = path.join(cwd, "public/build");
		const ssrDir = path.join(buildDir, "ssr");
		await fsp.mkdir(ssrDir, { recursive: true });
		// Minimal valid SSR module — exports a render() returning a string.
		// loadSsrModule probes `<buildDir>/ssr/ssr.js` first.
		await fsp.writeFile(
			path.join(ssrDir, "ssr.js"),
			"export function render() { return ''; }",
			"utf8",
		);
		await fsp.writeFile(
			path.join(buildDir, "manifest.json"),
			"not valid json {",
			"utf8",
		);

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const r = new PhotonRenderer(baseConfig);
			await r.boot();
			// boot() resolves cleanly — manifest read failure was swallowed.
			expect(warnSpy).toHaveBeenCalledTimes(1);
			const warnMessage = String(warnSpy.mock.calls[0]?.[0] ?? "");
			expect(warnMessage).toContain("manifest");
			expect(warnMessage).toContain(path.join(buildDir, "manifest.json"));
		} finally {
			warnSpy.mockRestore();
		}
	});
});
