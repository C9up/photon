/**
 * Dev SSR against a REAL Vite instance.
 *
 * The unit suite stands a fake compiler in for Vite, which proves the wiring
 * and nothing about the call itself: whether `createServer` accepts those
 * options, whether `ssrLoadModule` wants that URL shape, whether an edit is
 * actually picked up. Those are the parts that break when Vite changes, and
 * only a real one can answer them.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PhotonConfig, PhotonRenderer } from "../../src/PhotonRenderer.js";

let root: string;
let photon: PhotonRenderer;

const config = (appRoot: string): PhotonConfig => ({
	framework: "react",
	entryClient: "resources/app.tsx",
	// Plain TypeScript: the point is that Vite COMPILES it, without pulling a
	// framework plugin into this test.
	entryServer: "resources/ssr.ts",
	appRoot,
});

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "photon-vite-ssr-"));
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ name: "probe", type: "module", private: true }),
	);
	const resources = join(root, "resources");
	await mkdir(resources);
	await writeFile(
		join(resources, "label.ts"),
		`export const label = (n: string): string => \`compiled:\${n}\`\n`,
	);
	await writeFile(
		join(resources, "ssr.ts"),
		[
			'import { label } from "./label.js"',
			"export function render(page: { component: string }): string {",
			`  return \`<main>\${label(page.component)}</main>\``,
			"}",
			"",
		].join("\n"),
	);
	photon = new PhotonRenderer(config(root));
	await photon.boot();
}, 30_000);

afterAll(async () => {
	await photon?.close();
});

describe("photon > dev SSR through Vite", () => {
	it("compiles TypeScript and its transitive imports", async () => {
		const result = await photon.render("Dashboard", {}, "/");
		// Node could not have imported this file: it is TypeScript, and it
		// imports `./label.js`, which does not exist on disk under that name.
		expect(result.html).toContain("<main>compiled:Dashboard</main>");
	});

	it("picks up an edit without a restart", async () => {
		await writeFile(
			join(root, "resources", "label.ts"),
			`export const label = (n: string): string => \`edited:\${n}\`\n`,
		);
		const result = await photon.render("Dashboard", {}, "/");
		expect(result.html).toContain("<main>edited:Dashboard</main>");
	}, 15_000);
});
