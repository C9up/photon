import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { configure } from "../../src/configure.js";

interface Recorded {
	addProvider: string[];
	envVars: Record<string, string>[];
	files: Array<{ path: string; content: string; force?: boolean }>;
}

/**
 * Read a stub the way `codemods.makeUsingStub` does.
 *
 * The real file, not a fixture: a test that stubbed this out would pass with
 * a stub that does not exist.
 */
function renderStub(
	stubsRoot: string,
	stubPath: string,
	state: Record<string, string | number | boolean>,
): { to: string; body: string } {
	const raw = readFileSync(resolve(stubsRoot, stubPath), "utf8");
	const [, front = "", body = ""] = raw.split(/^---\r?\n/m, 3);
	const declared = /^to:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
	const render = (text: string): string =>
		text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
			state[key] === undefined ? match : String(state[key]),
		);
	return { to: render(declared), body: render(body) };
}

function makeCodemods(): {
	codemods: Parameters<typeof configure>[0];
	recorded: Recorded;
} {
	const recorded: Recorded = { addProvider: [], envVars: [], files: [] };
	const codemods: Parameters<typeof configure>[0] = {
		async addProvider(importPath) {
			recorded.addProvider.push(importPath);
		},
		async addEnvVars(vars) {
			recorded.envVars.push(vars);
		},
		async makeUsingStub(
			stubsRoot: string,
			stubPath: string,
			state: Record<string, string | number | boolean> = {},
		) {
			const { to, body } = renderStub(stubsRoot, stubPath, state);
			await this.writeFile(to, body);
			return { path: to, contents: body };
		},
		async writeFile(filePath, content, options) {
			recorded.files.push({ path: filePath, content, force: options?.force });
		},
	};
	return { codemods, recorded };
}

describe("photon > configure", () => {
	it("registers the photon provider import path", async () => {
		const { codemods, recorded } = makeCodemods();
		await configure(codemods);
		expect(recorded.addProvider).toEqual(["@c9up/photon/provider"]);
	});

	it("scaffolds config/photon.ts with a defineConfig() default export", async () => {
		const { codemods, recorded } = makeCodemods();
		await configure(codemods);
		const file = recorded.files.find((f) => f.path === "config/photon.ts");
		expect(file).toBeDefined();
		expect(file?.content).toContain("defineConfig");
		expect(file?.content).toContain("framework: 'react'");
		expect(file?.content).toContain("entryClient: 'resources/app.tsx'");
		expect(file?.content).toContain("entryServer: 'resources/ssr.tsx'");
	});
});
