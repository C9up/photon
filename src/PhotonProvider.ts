import "./augmentations.js";
import type { PhotonConfig } from "./PhotonRenderer.js";
import { PhotonRenderer } from "./PhotonRenderer.js";

interface PhotonContainer {
	singleton(token: unknown, factory: () => unknown): void;
	resolve<T = unknown>(token: unknown): Promise<T>;
}

interface PhotonConfigStore {
	get<T = unknown>(key: string): T | undefined;
}

export interface PhotonAppContext {
	container: PhotonContainer;
	config: PhotonConfigStore;
	/**
	 * Resolve a path against the application root (AdonisJS `app.makePath`).
	 *
	 * `public/build` means "under the application root", not "under whatever
	 * directory the process started in". Without this the manifest and the SSR
	 * entry were looked up relative to `process.cwd()`, so an application
	 * started by systemd or from the root of a monorepo found neither — and
	 * served an unhydrated shell instead of reporting it.
	 *
	 * Optional, because photon is agnostic: a host with no notion of an
	 * application root leaves the lookup cwd-relative, as before.
	 */
	makePath?(...segments: string[]): string;
}

export default class PhotonProvider {
	constructor(protected app: PhotonAppContext) {}

	register() {
		this.app.container.singleton(PhotonRenderer, () => {
			const config = this.app.config.get<PhotonConfig>("photon");
			if (!config)
				throw new Error("Photon config not found — create config/photon.ts");
			// The host knows where the application lives; the renderer should not
			// have to guess from the working directory. An explicit `appRoot` in
			// the config still wins — a deployment that lays the build out
			// elsewhere said so on purpose.
			const appRoot = config.appRoot ?? this.app.makePath?.();
			return new PhotonRenderer(
				appRoot === undefined ? config : { ...config, appRoot },
			);
		});

		this.app.container.singleton("photon", async () => {
			return await this.app.container.resolve<PhotonRenderer>(PhotonRenderer);
		});
	}

	async boot() {
		const renderer =
			await this.app.container.resolve<PhotonRenderer>(PhotonRenderer);
		await renderer.boot();
	}

	async shutdown() {}
}
