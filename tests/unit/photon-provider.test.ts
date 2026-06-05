import { describe, expect, it } from "vitest";
import PhotonProvider, {
	type PhotonAppContext,
} from "../../src/PhotonProvider.js";
import { PhotonRenderer } from "../../src/PhotonRenderer.js";

class FakeContainer {
	private factories = new Map<unknown, () => unknown>();
	private cache = new Map<unknown, unknown>();
	singleton(token: unknown, factory: () => unknown) {
		this.factories.set(token, factory);
	}
	resolve<T = unknown>(token: unknown): T {
		if (this.cache.has(token)) return this.cache.get(token) as T;
		const factory = this.factories.get(token);
		if (!factory) throw new Error(`No binding for ${String(token)}`);
		const value = factory();
		this.cache.set(token, value);
		return value as T;
	}
}

class FakeConfigStore {
	constructor(private store: Record<string, unknown>) {}
	get<T = unknown>(key: string): T | undefined {
		return this.store[key] as T | undefined;
	}
}

function makeApp(config: Record<string, unknown>): {
	app: PhotonAppContext;
	container: FakeContainer;
} {
	const container = new FakeContainer();
	const app: PhotonAppContext = {
		container,
		config: new FakeConfigStore(config),
	};
	return { app, container };
}

describe("photon > PhotonProvider", () => {
	it("register binds PhotonRenderer using the photon config", () => {
		const { app, container } = makeApp({
			photon: {
				framework: "react",
				entryClient: "resources/app.tsx",
				entryServer: "resources/ssr.tsx",
			},
		});
		new PhotonProvider(app).register();
		const renderer = container.resolve<PhotonRenderer>(PhotonRenderer);
		expect(renderer).toBeInstanceOf(PhotonRenderer);
		expect(renderer.getFramework()).toBe("react");
	});

	it("register exposes the same instance under the 'photon' alias", () => {
		const { app, container } = makeApp({
			photon: {
				framework: "vue",
				entryClient: "resources/app.ts",
				entryServer: "resources/ssr.ts",
			},
		});
		new PhotonProvider(app).register();
		const a = container.resolve<PhotonRenderer>(PhotonRenderer);
		const b = container.resolve<PhotonRenderer>("photon");
		expect(a).toBe(b);
	});

	it("throws a clear error when no photon config is registered", () => {
		const { app, container } = makeApp({}); // no 'photon' key
		new PhotonProvider(app).register();
		expect(() => container.resolve(PhotonRenderer)).toThrow(/Photon config/);
	});
});
