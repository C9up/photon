/**
 * The build lives under the APPLICATION root, not under the working directory.
 *
 * `path.resolve(process.cwd())` is only right when the process happens to have
 * started in the application's own directory. Under systemd, from the root of a
 * monorepo, or from anywhere a deployment finds convenient, photon looked for
 * the manifest and the SSR entry somewhere else — and then served an
 * unhydrated shell rather than saying it had found nothing.
 */

import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PhotonRenderer } from "../../src/PhotonRenderer.js";

const CONFIG = {
	framework: "react" as const,
	entryClient: "resources/app.tsx",
	entryServer: "resources/ssr.tsx",
};

let previousEnv: string | undefined;

beforeEach(() => {
	previousEnv = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
});
afterEach(() => {
	process.env.NODE_ENV = previousEnv;
});

/** A build laid out the way vite writes one. */
async function buildAt(root: string) {
	const dir = join(root, "public", "build", ".vite");
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "manifest.json"),
		JSON.stringify({
			"resources/ssr.tsx": { file: "assets/ssr.js", isEntry: true },
			"resources/app.tsx": { file: "assets/app.js", isEntry: true },
		}),
		"utf8",
	);
}

/** The paths a failed boot says it looked in. */
async function lookedIn(renderer: PhotonRenderer): Promise<string[]> {
	try {
		await renderer.boot();
		return [];
	} catch (error) {
		const context =
			error !== null && typeof error === "object"
				? Reflect.get(error, "context")
				: undefined;
		const candidates =
			context !== null && typeof context === "object"
				? Reflect.get(context, "candidates")
				: undefined;
		return Array.isArray(candidates) ? candidates.map(String) : [];
	}
}

describe("photon > where the build is looked up", () => {
	it("looks under the application root, whatever the cwd is", async () => {
		const root = mkdtempSync(join(tmpdir(), "photon-root-"));
		await buildAt(root);

		// The cwd is this package, which has no `public/build` at all — so a
		// renderer resolving against it would not even find the manifest.
		const candidates = await lookedIn(
			new PhotonRenderer({ ...CONFIG, appRoot: root }),
		);

		expect(candidates.length).toBeGreaterThan(0);
		for (const candidate of candidates) {
			expect(candidate.startsWith(root)).toBe(true);
		}
	});

	it("falls back to the cwd when the host names no root", async () => {
		// photon is agnostic: nothing here may REQUIRE an application root.
		const candidates = await lookedIn(new PhotonRenderer(CONFIG));

		// No manifest under this package either way; what matters is that the
		// lookup happened relative to the process, not that it succeeded.
		expect(candidates.every((c) => !c.startsWith(tmpdir()))).toBe(true);
	});

	it("reports the miss instead of serving an empty shell", async () => {
		const empty = mkdtempSync(join(tmpdir(), "photon-empty-"));

		// The failure a wrong root produces has to be loud: an application that
		// silently drops SSR looks like a hydration bug for as long as it takes
		// to find out it never had a manifest.
		await expect(
			new PhotonRenderer({ ...CONFIG, appRoot: empty }).boot(),
		).rejects.toThrow();
	});
});
