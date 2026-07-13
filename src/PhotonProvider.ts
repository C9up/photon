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
}

export default class PhotonProvider {
	constructor(protected app: PhotonAppContext) {}

	register() {
		this.app.container.singleton(PhotonRenderer, () => {
			const config = this.app.config.get<PhotonConfig>("photon");
			if (!config)
				throw new Error("Photon config not found — create config/photon.ts");
			return new PhotonRenderer(config);
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
