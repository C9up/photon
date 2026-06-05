import { describe, expect, it } from "vitest";
import { configure } from "../../src/configure.js";

interface Recorded {
	addProvider: string[];
	envVars: Record<string, string>[];
	files: Array<{ path: string; content: string; force?: boolean }>;
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
