import { BaseConsumer, NonRetryableError } from "@xmer/consumer-shared";
import type { ConsumeMessage } from "amqplib";
import { VALID_CATEGORIES } from "../types/index.js";
import type {
	DownloadConsumerOptions,
	IQBittorrentClient,
	IStateManager,
} from "../types/index.js";

export class DownloadConsumer extends BaseConsumer {
	private readonly qbittorrentClient: IQBittorrentClient;
	private readonly stateManager: IStateManager;

	constructor(options: DownloadConsumerOptions) {
		super(options);
		this.qbittorrentClient = options.qbittorrentClient;
		this.stateManager = options.stateManager;
	}

	protected async processMessage(
		content: Record<string, unknown>,
		_message: ConsumeMessage,
	): Promise<void> {
		const id = content.id;
		if (typeof id !== "string" || id.length === 0) {
			throw new NonRetryableError(
				"Invalid or missing id",
				"ERR_INVALID_MESSAGE",
				{ id },
			);
		}

		const magnetLink = content.magnetLink;
		if (typeof magnetLink !== "string" || !magnetLink.startsWith("magnet:")) {
			throw new NonRetryableError(
				"Invalid or missing magnetLink",
				"ERR_INVALID_MESSAGE",
				{ magnetLink },
			);
		}

		const category = content.category;
		if (typeof category !== "string" || !VALID_CATEGORIES.has(category)) {
			throw new NonRetryableError(
				`Invalid category: ${String(category)}. Must be one of: sonarr, radarr, games`,
				"ERR_INVALID_CATEGORY",
				{ category },
			);
		}

		const hash = await this.qbittorrentClient.addTorrent(magnetLink, category);
		await this.stateManager.addHash(hash, { id, name: "", category });
	}
}
