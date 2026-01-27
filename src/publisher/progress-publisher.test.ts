import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Channel } from "amqplib";
import type { ILogger, IPublisher } from "consumer-shared";
import type {
	IQBittorrentClient,
	IStateManager,
	QBittorrentTorrentInfo,
	TorrentMetadata,
} from "../types/index.js";
import { ProgressPublisher } from "./progress-publisher.js";

const mockLogger: ILogger = {
	debug: mock(() => {}),
	info: mock(() => {}),
	warn: mock(() => {}),
	error: mock(() => {}),
	child: mock(() => mockLogger),
};

function createMockChannel(): Channel {
	return {
		assertExchange: mock(() => Promise.resolve({ exchange: "qbittorrent" })),
		publish: mock(() => true),
	} as unknown as Channel;
}

function createMockQBClient(
	torrents: QBittorrentTorrentInfo[] = [],
): IQBittorrentClient {
	return {
		login: mock(() => Promise.resolve()),
		addTorrent: mock(() => Promise.resolve("hash")),
		getTorrentsInfo: mock(() => Promise.resolve(torrents)),
	};
}

function createMockStateManager(
	hashes: string[] = [],
	metadataMap: Map<string, TorrentMetadata> = new Map(),
): IStateManager {
	return {
		addHash: mock(() => Promise.resolve()),
		removeHash: mock(() => Promise.resolve()),
		getTrackedHashes: mock(() => Promise.resolve(hashes)),
		getMetadata: mock((hash: string) => metadataMap.get(hash)),
		setMetadata: mock(() => {}),
		loadMetadataFromApi: mock(() => {}),
		close: mock(() => Promise.resolve()),
	};
}

function createMockNotificationsPublisher(): IPublisher {
	return {
		publish: mock(() => Promise.resolve()),
	};
}

function createPublisher(
	overrides: {
		channel?: Channel;
		qbClient?: IQBittorrentClient;
		stateManager?: IStateManager;
		notificationsPublisher?: IPublisher;
		intervalMs?: number;
	} = {},
): ProgressPublisher {
	return new ProgressPublisher({
		channel: overrides.channel ?? createMockChannel(),
		exchange: "qbittorrent",
		logger: mockLogger,
		qbittorrentClient: overrides.qbClient ?? createMockQBClient(),
		stateManager: overrides.stateManager ?? createMockStateManager(),
		intervalMs: overrides.intervalMs ?? 30000,
		notificationsPublisher:
			overrides.notificationsPublisher ?? createMockNotificationsPublisher(),
	});
}

describe("ProgressPublisher", () => {
	afterEach(() => {
		// Clean up any running intervals
	});

	describe("pollAndPublish", () => {
		it("should return early when no tracked hashes", async () => {
			// Arrange
			const qbClient = createMockQBClient();
			const publisher = createPublisher({
				stateManager: createMockStateManager([]),
				qbClient,
			});

			// Act
			await publisher.pollAndPublish();

			// Assert
			expect(qbClient.getTorrentsInfo).not.toHaveBeenCalled();
		});

		it("should publish downloads.progress for active torrents", async () => {
			// Arrange
			const torrent: QBittorrentTorrentInfo = {
				hash: "h1",
				name: "Test Torrent",
				progress: 0.45,
				dlspeed: 5242880,
				eta: 3600,
				state: "downloading",
				category: "sonarr",
				size: 1024,
			};
			const channel = createMockChannel();
			const publisher = createPublisher({
				channel,
				qbClient: createMockQBClient([torrent]),
				stateManager: createMockStateManager(["h1"]),
			});

			// Act
			await publisher.pollAndPublish();

			// Assert
			expect(channel.publish).toHaveBeenCalled();
			const call = (channel.publish as ReturnType<typeof mock>).mock.calls[0];
			expect(call?.[0]).toBe("qbittorrent");
			expect(call?.[1]).toBe("downloads.progress");
		});

		it("should publish downloads.complete and remove hash when progress >= 1.0", async () => {
			// Arrange
			const torrent: QBittorrentTorrentInfo = {
				hash: "h1",
				name: "Done Torrent",
				progress: 1.0,
				dlspeed: 0,
				eta: 0,
				state: "uploading",
				category: "radarr",
				size: 2048,
			};
			const channel = createMockChannel();
			const stateManager = createMockStateManager(["h1"]);
			const publisher = createPublisher({
				channel,
				qbClient: createMockQBClient([torrent]),
				stateManager,
			});

			// Act
			await publisher.pollAndPublish();

			// Assert
			const publishCalls = (channel.publish as ReturnType<typeof mock>).mock
				.calls;
			const routingKeys = publishCalls.map((c: unknown[]) => c[1]);
			expect(routingKeys).toContain("downloads.complete");
			expect(stateManager.removeHash).toHaveBeenCalledWith("h1");
		});

		it("should publish downloads.stalled for stalledDL state", async () => {
			// Arrange
			const torrent: QBittorrentTorrentInfo = {
				hash: "h1",
				name: "Stalled",
				progress: 0.2,
				dlspeed: 0,
				eta: 8640000,
				state: "stalledDL",
				category: "sonarr",
				size: 1024,
			};
			const channel = createMockChannel();
			const publisher = createPublisher({
				channel,
				qbClient: createMockQBClient([torrent]),
				stateManager: createMockStateManager(["h1"]),
			});

			// Act
			await publisher.pollAndPublish();

			// Assert
			const call = (channel.publish as ReturnType<typeof mock>).mock.calls[0];
			expect(call?.[1]).toBe("downloads.stalled");
		});

		it("should publish downloads.paused for pausedDL state", async () => {
			// Arrange
			const torrent: QBittorrentTorrentInfo = {
				hash: "h1",
				name: "Paused",
				progress: 0.3,
				dlspeed: 0,
				eta: 0,
				state: "pausedDL",
				category: "games",
				size: 4096,
			};
			const channel = createMockChannel();
			const publisher = createPublisher({
				channel,
				qbClient: createMockQBClient([torrent]),
				stateManager: createMockStateManager(["h1"]),
			});

			// Act
			await publisher.pollAndPublish();

			// Assert
			const call = (channel.publish as ReturnType<typeof mock>).mock.calls[0];
			expect(call?.[1]).toBe("downloads.paused");
		});

		it("should publish downloads.removed when hash not in API response", async () => {
			// Arrange
			const metadata = new Map([
				["gone", { id: "req-1", name: "Removed Torrent", category: "sonarr" }],
			]);
			const channel = createMockChannel();
			const stateManager = createMockStateManager(["gone"], metadata);
			const publisher = createPublisher({
				channel,
				qbClient: createMockQBClient([]),
				stateManager,
			});

			// Act
			await publisher.pollAndPublish();

			// Assert
			const publishCalls = (channel.publish as ReturnType<typeof mock>).mock
				.calls;
			const routingKeys = publishCalls.map((c: unknown[]) => c[1]);
			expect(routingKeys).toContain("downloads.removed");
			expect(stateManager.removeHash).toHaveBeenCalledWith("gone");
		});

		it("should use fallback metadata when hash has no metadata", async () => {
			// Arrange
			const channel = createMockChannel();
			const stateManager = createMockStateManager(["gone"]);
			const publisher = createPublisher({
				channel,
				qbClient: createMockQBClient([]),
				stateManager,
			});

			// Act
			await publisher.pollAndPublish();

			// Assert
			const publishCalls = (channel.publish as ReturnType<typeof mock>).mock
				.calls;
			const removedCall = publishCalls.find(
				(c: unknown[]) => c[1] === "downloads.removed",
			);
			expect(removedCall).toBeDefined();
			const payload = JSON.parse((removedCall?.[2] as Buffer).toString());
			expect(payload.name).toBe("unknown");
			expect(payload.category).toBe("unknown");
		});

		it("should NOT treat pending hashes as removed", async () => {
			// Arrange
			const channel = createMockChannel();
			const stateManager = createMockStateManager(["pending-hash"]);
			const publisher = createPublisher({
				channel,
				qbClient: createMockQBClient([]),
				stateManager,
			});

			// Mark hash as pending (just added, not yet in poll)
			publisher.addPendingHash("pending-hash");

			// Act
			await publisher.pollAndPublish();

			// Assert
			const publishCalls = (channel.publish as ReturnType<typeof mock>).mock
				.calls;
			const routingKeys = publishCalls.map((c: unknown[]) => c[1]);
			expect(routingKeys).not.toContain("downloads.removed");
			expect(stateManager.removeHash).not.toHaveBeenCalled();
		});

		it("should clear pending hash once seen in API response", async () => {
			// Arrange
			const torrent: QBittorrentTorrentInfo = {
				hash: "h1",
				name: "Now Visible",
				progress: 0.1,
				dlspeed: 1000,
				eta: 100,
				state: "downloading",
				category: "sonarr",
				size: 512,
			};
			const stateManager = createMockStateManager(["h1"]);
			const publisher = createPublisher({
				qbClient: createMockQBClient([torrent]),
				stateManager,
			});
			publisher.addPendingHash("h1");

			// Act — first poll: hash seen, should be cleared from pending
			await publisher.pollAndPublish();

			// Now simulate second poll where hash disappears
			(
				stateManager.getTrackedHashes as ReturnType<typeof mock>
			).mockReturnValue(Promise.resolve(["h1"]));
			const emptyClient = createMockQBClient([]);
			const channel = createMockChannel();
			const publisher2 = createPublisher({
				channel,
				qbClient: emptyClient,
				stateManager,
			});

			await publisher2.pollAndPublish();

			// Assert — should be treated as removed since no longer pending
			const publishCalls = (channel.publish as ReturnType<typeof mock>).mock
				.calls;
			const routingKeys = publishCalls.map((c: unknown[]) => c[1]);
			expect(routingKeys).toContain("downloads.removed");
		});

		it("should call loadMetadataFromApi on successful poll", async () => {
			// Arrange
			const torrent: QBittorrentTorrentInfo = {
				hash: "h1",
				name: "Test",
				progress: 0.5,
				dlspeed: 100,
				eta: 60,
				state: "downloading",
				category: "sonarr",
				size: 1024,
			};
			const stateManager = createMockStateManager(["h1"]);
			const publisher = createPublisher({
				qbClient: createMockQBClient([torrent]),
				stateManager,
			});

			// Act
			await publisher.pollAndPublish();

			// Assert
			expect(stateManager.loadMetadataFromApi).toHaveBeenCalledWith([torrent]);
		});
	});

	describe("poll failure alerting", () => {
		it("should log warning on poll failure", async () => {
			// Arrange
			const qbClient = createMockQBClient();
			(qbClient.getTorrentsInfo as ReturnType<typeof mock>).mockRejectedValue(
				new Error("Connection refused"),
			);
			const publisher = createPublisher({
				qbClient,
				stateManager: createMockStateManager(["h1"]),
			});

			// Act
			await publisher.pollAndPublish();

			// Assert — no crash, warning logged
			expect(mockLogger.warn).toHaveBeenCalled();
		});

		it("should send alert after 10 minutes of continuous failure", async () => {
			// Arrange
			const qbClient = createMockQBClient();
			(qbClient.getTorrentsInfo as ReturnType<typeof mock>).mockRejectedValue(
				new Error("Connection refused"),
			);
			const notificationsPublisher = createMockNotificationsPublisher();
			const stateManager = createMockStateManager(["h1"]);
			const publisher = createPublisher({
				qbClient,
				stateManager,
				notificationsPublisher,
			});

			// Act — first poll sets firstFailureAt
			await publisher.pollAndPublish();

			// Simulate 10+ minutes by manipulating internal state
			// Access private field via any cast for testing
			(publisher as unknown as { firstFailureAt: number }).firstFailureAt =
				Date.now() - 11 * 60 * 1000;

			// Second poll triggers alert
			await publisher.pollAndPublish();

			// Assert
			expect(notificationsPublisher.publish).toHaveBeenCalledWith(
				"notifications.polling.failure",
				expect.objectContaining({
					service: "qbittorrent-consumer",
				}),
			);
		});

		it("should only send alert once per failure window", async () => {
			// Arrange
			const qbClient = createMockQBClient();
			(qbClient.getTorrentsInfo as ReturnType<typeof mock>).mockRejectedValue(
				new Error("Connection refused"),
			);
			const notificationsPublisher = createMockNotificationsPublisher();
			const stateManager = createMockStateManager(["h1"]);
			const publisher = createPublisher({
				qbClient,
				stateManager,
				notificationsPublisher,
			});

			// Set failure to 11 minutes ago
			(publisher as unknown as { firstFailureAt: number }).firstFailureAt =
				Date.now() - 11 * 60 * 1000;

			// Act — trigger alert
			await publisher.pollAndPublish();
			// Act — second poll should NOT send again
			await publisher.pollAndPublish();

			// Assert
			expect(notificationsPublisher.publish).toHaveBeenCalledTimes(1);
		});

		it("should reset failure tracking on successful poll", async () => {
			// Arrange
			const torrent: QBittorrentTorrentInfo = {
				hash: "h1",
				name: "Test",
				progress: 0.5,
				dlspeed: 100,
				eta: 60,
				state: "downloading",
				category: "sonarr",
				size: 1024,
			};
			const qbClient = createMockQBClient([torrent]);
			const notificationsPublisher = createMockNotificationsPublisher();
			const stateManager = createMockStateManager(["h1"]);
			const publisher = createPublisher({
				qbClient,
				stateManager,
				notificationsPublisher,
			});

			// Set failure state
			(publisher as unknown as { firstFailureAt: number }).firstFailureAt =
				Date.now() - 11 * 60 * 1000;
			(publisher as unknown as { alertSent: boolean }).alertSent = true;

			// Act — successful poll resets
			await publisher.pollAndPublish();

			// Assert — failure tracking should be reset
			expect(
				(publisher as unknown as { firstFailureAt: number | null })
					.firstFailureAt,
			).toBeNull();
			expect((publisher as unknown as { alertSent: boolean }).alertSent).toBe(
				false,
			);
		});
	});

	describe("startPolling / stopPolling", () => {
		it("should start and stop polling", () => {
			// Arrange
			const publisher = createPublisher({ intervalMs: 60000 });

			// Act
			publisher.startPolling();
			publisher.stopPolling();

			// Assert — no crash, interval cleared
			expect(mockLogger.info).toHaveBeenCalled();
		});

		it("should poll on interval tick", async () => {
			// Arrange
			const stateManager = createMockStateManager([]);
			const publisher = createPublisher({
				stateManager,
				intervalMs: 10,
			});

			// Act — start polling and wait for interval to fire
			publisher.startPolling();
			await new Promise((resolve) => setTimeout(resolve, 50));
			publisher.stopPolling();

			// Assert — getTrackedHashes called multiple times (initial + interval)
			expect(
				(stateManager.getTrackedHashes as ReturnType<typeof mock>).mock.calls
					.length,
			).toBeGreaterThan(1);
		});

		it("should handle stopPolling when not started", () => {
			// Arrange
			const publisher = createPublisher();

			// Act & Assert — should not throw
			publisher.stopPolling();
		});
	});
});
