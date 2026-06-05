import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Drift gates that prevent code/docs divergence on the Photon error catalog.
 *
 * The source-side set is lifted DIRECTLY from the `PhotonErrorCode` and
 * `PhotonClientErrorCode` literal unions in `errors.ts` / `client/errors.ts`
 * — the type IS the source of truth. Lifting from the union (instead of a
 * regex over arbitrary `.ts` files) eliminates four false-positive vectors:
 * over-matching string constants like `"PHOTON_*"` logger keys, JSDoc
 * backtick references, source files not listed in a hand-curated array, and
 * future double-quoted `PHOTON_*` literals that aren't throw arguments.
 */

const ERRORS_TS = "../../src/errors.ts";
const CLIENT_ERRORS_TS = "../../src/client/errors.ts";
const DOCS_EN = "../../../../docs/en/errors/index.md";
const DOCS_FR = "../../../../docs/fr/errors/index.md";

const headingRegex = /^### (PHOTON_[A-Z_]+)\s*$/gm;

/**
 * Pull the literal union members from a TypeScript source file. The pattern
 * matches `export type X = | "PHOTON_FOO" | "PHOTON_BAR" ...` blocks. Anchored
 * on a quoted code immediately preceded by `|` or `=` and surrounding
 * whitespace so it doesn't catch references inside JSDoc / function bodies.
 */
const unionMemberRegex = /[|=]\s*"(PHOTON_[A-Z_]+)"/g;

async function loadUnionCodes(relPath: string): Promise<Set<string>> {
	const text = await readFile(new URL(relPath, import.meta.url), "utf-8");
	return new Set([...text.matchAll(unionMemberRegex)].map((m) => m[1]));
}

async function loadDocsHeadings(relPath: string): Promise<Set<string>> {
	const text = await readFile(new URL(relPath, import.meta.url), "utf-8");
	return new Set([...text.matchAll(headingRegex)].map((m) => m[1]));
}

async function loadAllSourceCodes(): Promise<Set<string>> {
	const [server, client] = await Promise.all([
		loadUnionCodes(ERRORS_TS),
		loadUnionCodes(CLIENT_ERRORS_TS),
	]);
	return new Set([...server, ...client]);
}

/**
 * Walk a docs file and, for every `### PHOTON_FOO` heading, collect the body
 * text up to the NEXT `### ` heading (or EOF). Returns a map code → body.
 * The body-presence drift gate uses this to verify each entry has the
 * expected structural markers (Cause / Fix lines).
 */
async function loadDocsSections(relPath: string): Promise<Map<string, string>> {
	const text = await readFile(new URL(relPath, import.meta.url), "utf-8");
	const sections = new Map<string, string>();
	const split = text.split(/^### /gm);
	for (const chunk of split) {
		const headingMatch = chunk.match(/^(PHOTON_[A-Z_]+)\s*\n/);
		if (!headingMatch) continue;
		const code = headingMatch[1];
		const body = chunk.slice(headingMatch[0].length).split(/^### /m)[0];
		sections.set(code, body);
	}
	return sections;
}

describe("photon > error catalog drift gate", () => {
	it("every PHOTON_* code in the type unions is documented in docs/en/errors/index.md", async () => {
		const sourceCodes = await loadAllSourceCodes();
		const docsCodes = await loadDocsHeadings(DOCS_EN);
		const missing = [...sourceCodes].filter((c) => !docsCodes.has(c));
		expect(
			missing,
			`Source codes missing from docs/en: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("every PHOTON_* heading in docs/en/errors/index.md is in a source union", async () => {
		const sourceCodes = await loadAllSourceCodes();
		const docsCodes = await loadDocsHeadings(DOCS_EN);
		const stale = [...docsCodes].filter((c) => !sourceCodes.has(c));
		expect(
			stale,
			`Doc-only codes (renamed/removed in source?): ${stale.join(", ")}`,
		).toEqual([]);
	});

	it("docs/fr/errors/index.md has the same Photon code set as docs/en/errors/index.md", async () => {
		const enCodes = await loadDocsHeadings(DOCS_EN);
		const frCodes = await loadDocsHeadings(DOCS_FR);
		const missingFromFr = [...enCodes].filter((c) => !frCodes.has(c));
		const missingFromEn = [...frCodes].filter((c) => !enCodes.has(c));
		expect(
			missingFromFr,
			`Codes in EN but not FR: ${missingFromFr.join(", ")}`,
		).toEqual([]);
		expect(
			missingFromEn,
			`Codes in FR but not EN: ${missingFromEn.join(", ")}`,
		).toEqual([]);
	});

	it("every PHOTON_* heading in docs/en has a non-trivial body with Cause + Fix markers", async () => {
		const sections = await loadDocsSections(DOCS_EN);
		const missingMarkers: string[] = [];
		for (const [code, body] of sections) {
			if (!body.includes("**Cause.**") || !body.includes("**Fix.**")) {
				missingMarkers.push(code);
			}
		}
		expect(
			missingMarkers,
			`EN entries missing Cause or Fix body: ${missingMarkers.join(", ")}`,
		).toEqual([]);
	});

	it("every PHOTON_* heading in docs/fr has a non-trivial body with Cause + Fix markers", async () => {
		const sections = await loadDocsSections(DOCS_FR);
		const missingMarkers: string[] = [];
		for (const [code, body] of sections) {
			if (!body.includes("**Cause.**") || !body.includes("**Fix.**")) {
				missingMarkers.push(code);
			}
		}
		expect(
			missingMarkers,
			`FR entries missing Cause or Fix body: ${missingMarkers.join(", ")}`,
		).toEqual([]);
	});
});
