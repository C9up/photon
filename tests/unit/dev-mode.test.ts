/**
 * Development mode is opted into, never assumed.
 *
 * Anything but `NODE_ENV=production` used to mean development: an image that
 * never set NODE_ENV, or set the `prod` alias, served its pages with scripts
 * from `localhost:5173`, no asset versioning and a CSP open to any websocket.
 * Only an explicit signal now selects the Vite dev server.
 */
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PhotonConfig, PhotonRenderer } from "../../src/PhotonRenderer.js";

const CONFIG: PhotonConfig = {
	framework: "react",
	entryClient: "resources/app.tsx",
};

const saved = {
	nodeEnv: process.env.NODE_ENV,
	reamDev: process.env.REAM_DEV,
};

function setEnv(name: "NODE_ENV" | "REAM_DEV", value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

beforeEach(() => {
	setEnv("NODE_ENV", undefined);
	setEnv("REAM_DEV", undefined);
});
afterEach(() => {
	setEnv("NODE_ENV", saved.nodeEnv);
	setEnv("REAM_DEV", saved.reamDev);
});

/** An application root holding a client build, as vite writes it. */
async function builtApp(): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "photon-devmode-"));
	const dir = join(root, "public", "build", ".vite");
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "manifest.json"),
		JSON.stringify({
			"resources/app.tsx": { file: "assets/app.js", isEntry: true },
		}),
		"utf8",
	);
	return root;
}

async function page(config: Partial<PhotonConfig> = {}) {
	const renderer = new PhotonRenderer({
		...CONFIG,
		appRoot: await builtApp(),
		...config,
	});
	await renderer.boot();
	const result = await renderer.render("Home", {}, "/");
	return {
		html: result.html,
		csp: result.headers["content-security-policy"] ?? "",
		version: renderer.getVersion(),
	};
}

function expectProduction(out: Awaited<ReturnType<typeof page>>) {
	expect(out.html).toContain('src="/build/assets/app.js"');
	expect(out.html).not.toContain("localhost:5173");
	expect(out.csp).not.toContain("ws:");
	expect(out.csp).not.toContain("unsafe-inline");
	// The manifest fingerprint, so a deploy forces the reload.
	expect(out.version).not.toBe("1");
}

function expectDevelopment(out: Awaited<ReturnType<typeof page>>) {
	expect(out.html).toContain("http://localhost:5173/@vite/client");
	expect(out.version).toBe("1");
}

describe("photon > development mode", () => {
	it("serves the built assets when NODE_ENV is unset", async () => {
		expectProduction(await page());
	});

	it.each(["production", "prod", "PROD", "staging"])(
		"serves the built assets when NODE_ENV=%s",
		async (value) => {
			setEnv("NODE_ENV", value);
			expectProduction(await page());
		},
	);

	it("requires the manifest when NODE_ENV is unset", async () => {
		const empty = mkdtempSync(join(tmpdir(), "photon-devmode-empty-"));
		await expect(
			new PhotonRenderer({ ...CONFIG, appRoot: empty }).boot(),
		).rejects.toMatchObject({ code: "E_PHOTON_MANIFEST_MISSING" });
	});

	it.each(["development", "dev", "Develop", "test", "testing"])(
		"uses the Vite dev server when NODE_ENV=%s",
		async (value) => {
			setEnv("NODE_ENV", value);
			expectDevelopment(await page());
		},
	);

	it("uses the Vite dev server under `ream dev`, NODE_ENV unset", async () => {
		setEnv("REAM_DEV", "true");
		expectDevelopment(await page());
	});

	it("lets the config say development explicitly", async () => {
		expectDevelopment(await page({ dev: true }));
	});

	it("lets the config force production in a development environment", async () => {
		setEnv("NODE_ENV", "development");
		expectProduction(await page({ dev: false }));
	});
});
