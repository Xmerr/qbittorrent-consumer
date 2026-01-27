import type { ILogger } from "consumer-shared";
import type { Redis } from "ioredis";
import type {
	IStateManager,
	QBittorrentTorrentInfo,
	StateManagerOptions,
	TorrentMetadata,
} from "../types/index.js";

const REDIS_KEY = "qbittorrent-consumer:tracked-torrents";

export class StateManager implements IStateManager {
	private readonly redis: Redis;
	private readonly logger: ILogger;
	private readonly metadata = new Map<string, TorrentMetadata>();

	constructor(options: StateManagerOptions) {
		this.redis = options.redis;
		this.logger = options.logger.child({ component: "StateManager" });
	}

	async addHash(hash: string, metadata: TorrentMetadata): Promise<void> {
		await this.redis.sadd(REDIS_KEY, hash);
		this.metadata.set(hash, metadata);
		this.logger.debug("Hash tracked", { hash });
	}

	async removeHash(hash: string): Promise<void> {
		await this.redis.srem(REDIS_KEY, hash);
		this.metadata.delete(hash);
		this.logger.debug("Hash untracked", { hash });
	}

	async getTrackedHashes(): Promise<string[]> {
		return this.redis.smembers(REDIS_KEY);
	}

	getMetadata(hash: string): TorrentMetadata | undefined {
		return this.metadata.get(hash);
	}

	setMetadata(hash: string, metadata: TorrentMetadata): void {
		this.metadata.set(hash, metadata);
	}

	loadMetadataFromApi(torrents: QBittorrentTorrentInfo[]): void {
		for (const torrent of torrents) {
			const existing = this.metadata.get(torrent.hash);
			this.metadata.set(torrent.hash, {
				id: existing?.id ?? "",
				name: torrent.name,
				category: torrent.category,
			});
		}
	}

	async close(): Promise<void> {
		await this.redis.quit();
		this.logger.info("Redis connection closed");
	}
}
