import { BasePublisher } from "@xmer/consumer-shared";
import type { ILogger, IPublisher } from "@xmer/consumer-shared";
import type {
	IProgressPublisher,
	IQBittorrentClient,
	IStateManager,
	ProgressPublisherOptions,
	QBittorrentTorrentInfo,
} from "../types/index.js";

const POLL_FAILURE_ALERT_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export class ProgressPublisher
	extends BasePublisher
	implements IProgressPublisher
{
	private readonly qbittorrentClient: IQBittorrentClient;
	private readonly stateManager: IStateManager;
	private readonly intervalMs: number;
	private readonly notificationsPublisher: IPublisher;
	private readonly log: ILogger;
	private readonly pendingHashes = new Set<string>();
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private firstFailureAt: number | null = null;
	private alertSent = false;

	constructor(options: ProgressPublisherOptions) {
		super(options);
		this.qbittorrentClient = options.qbittorrentClient;
		this.stateManager = options.stateManager;
		this.intervalMs = options.intervalMs;
		this.notificationsPublisher = options.notificationsPublisher;
		this.log = options.logger.child({ component: "ProgressPublisher" });
	}

	addPendingHash(hash: string): void {
		this.pendingHashes.add(hash);
	}

	startPolling(): void {
		void this.pollAndPublish();
		this.intervalId = setInterval(() => {
			void this.pollAndPublish();
		}, this.intervalMs);
		this.log.info("Polling started", { intervalMs: this.intervalMs });
	}

	stopPolling(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.log.info("Polling stopped");
	}

	async pollAndPublish(): Promise<void> {
		const hashes = await this.stateManager.getTrackedHashes();
		if (hashes.length === 0) {
			return;
		}

		let torrents: QBittorrentTorrentInfo[];
		try {
			torrents = await this.qbittorrentClient.getTorrentsInfo(hashes);
		} catch (error) {
			await this.handlePollFailure(error as Error);
			return;
		}

		this.resetFailureTracking();
		this.stateManager.loadMetadataFromApi(torrents);

		const apiHashes = new Set(torrents.map((t) => t.hash));

		for (const hash of hashes) {
			if (!apiHashes.has(hash) && !this.pendingHashes.has(hash)) {
				await this.publishRemoved(hash);
			}
		}

		for (const hash of hashes) {
			if (apiHashes.has(hash)) {
				this.pendingHashes.delete(hash);
			}
		}

		for (const torrent of torrents) {
			await this.publishTorrentState(torrent);
		}
	}

	private async publishTorrentState(
		torrent: QBittorrentTorrentInfo,
	): Promise<void> {
		const metadata = this.stateManager.getMetadata(torrent.hash);
		const id = metadata?.id ?? "";

		if (torrent.progress >= 1.0) {
			await this.publish("downloads.complete", {
				id,
				hash: torrent.hash,
				name: torrent.name,
				size: torrent.size,
				category: torrent.category,
			});
			await this.stateManager.removeHash(torrent.hash);
			return;
		}

		if (torrent.state === "stalledDL") {
			await this.publish("downloads.stalled", {
				id,
				hash: torrent.hash,
				name: torrent.name,
				progress: torrent.progress,
				downloadSpeed: torrent.dlspeed,
				eta: torrent.eta,
				state: torrent.state,
				category: torrent.category,
			});
			return;
		}

		if (torrent.state === "pausedDL") {
			await this.publish("downloads.paused", {
				id,
				hash: torrent.hash,
				name: torrent.name,
				progress: torrent.progress,
				downloadSpeed: torrent.dlspeed,
				eta: torrent.eta,
				state: torrent.state,
				category: torrent.category,
			});
			return;
		}

		await this.publish("downloads.progress", {
			id,
			hash: torrent.hash,
			name: torrent.name,
			progress: torrent.progress,
			downloadSpeed: torrent.dlspeed,
			eta: torrent.eta,
			state: torrent.state,
			category: torrent.category,
		});
	}

	private async publishRemoved(hash: string): Promise<void> {
		const metadata = this.stateManager.getMetadata(hash);
		await this.publish("downloads.removed", {
			id: metadata?.id ?? "",
			hash,
			name: metadata?.name ?? "unknown",
			category: metadata?.category ?? "unknown",
		});
		await this.stateManager.removeHash(hash);
	}

	private async handlePollFailure(error: Error): Promise<void> {
		this.log.warn("Poll failed", { error: error.message });

		if (this.firstFailureAt === null) {
			this.firstFailureAt = Date.now();
		}

		const elapsed = Date.now() - this.firstFailureAt;
		if (elapsed >= POLL_FAILURE_ALERT_THRESHOLD_MS && !this.alertSent) {
			await this.notificationsPublisher.publish(
				"notifications.polling.failure",
				{
					service: "qbittorrent-consumer",
					error: error.message,
					failingSinceMs: elapsed,
					timestamp: new Date().toISOString(),
				},
			);
			this.alertSent = true;
			this.log.error("Polling failure alert sent", { elapsedMs: elapsed });
		}
	}

	private resetFailureTracking(): void {
		this.firstFailureAt = null;
		this.alertSent = false;
	}
}
