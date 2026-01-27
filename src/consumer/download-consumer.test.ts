import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { IDlqHandler, ILogger } from "@xmer/consumer-shared";
import type { Channel, ConsumeMessage } from "amqplib";
import type { IQBittorrentClient, IStateManager } from "../types/index.js";
import { DownloadConsumer } from "./download-consumer.js";

const mockLogger: ILogger = {
	debug: mock(() => {}),
	info: mock(() => {}),
	warn: mock(() => {}),
	error: mock(() => {}),
	child: mock(() => mockLogger),
};

function createMockChannel(): Channel {
	let consumeCallback: ((msg: ConsumeMessage | null) => void) | null = null;
	return {
		prefetch: mock(() => Promise.resolve()),
		assertExchange: mock(() => Promise.resolve({ exchange: "qbittorrent" })),
		assertQueue: mock(() =>
			Promise.resolve({
				queue: "downloads.add",
				messageCount: 0,
				consumerCount: 0,
			}),
		),
		bindQueue: mock(() => Promise.resolve()),
		consume: mock(
			(_queue: string, cb: (msg: ConsumeMessage | null) => void) => {
				consumeCallback = cb;
				return Promise.resolve({ consumerTag: "tag-1" });
			},
		),
		ack: mock(() => {}),
		nack: mock(() => {}),
		cancel: mock(() => Promise.resolve()),
		publish: mock(() => true),
		_simulateMessage: (content: Record<string, unknown>) => {
			const msg = {
				content: Buffer.from(JSON.stringify(content)),
				fields: { routingKey: "downloads.add", deliveryTag: 1 },
				properties: { headers: {} },
			} as unknown as ConsumeMessage;
			consumeCallback?.(msg);
			return msg;
		},
	} as unknown as Channel & {
		_simulateMessage: (content: Record<string, unknown>) => ConsumeMessage;
	};
}

function createMockDlqHandler(): IDlqHandler {
	return {
		setup: mock(() => Promise.resolve()),
		handleRetryableError: mock(() => Promise.resolve()),
		handleNonRetryableError: mock(() => Promise.resolve()),
	};
}

function createMockQBittorrentClient(): IQBittorrentClient {
	return {
		login: mock(() => Promise.resolve()),
		addTorrent: mock(() => Promise.resolve("abc123hash")),
		getTorrentsInfo: mock(() => Promise.resolve([])),
	};
}

function createMockStateManager(): IStateManager {
	return {
		addHash: mock(() => Promise.resolve()),
		removeHash: mock(() => Promise.resolve()),
		getTrackedHashes: mock(() => Promise.resolve([])),
		getMetadata: mock(() => undefined),
		setMetadata: mock(() => {}),
		loadMetadataFromApi: mock(() => {}),
		close: mock(() => Promise.resolve()),
	};
}

describe("DownloadConsumer", () => {
	let channel: ReturnType<typeof createMockChannel>;
	let dlqHandler: IDlqHandler;
	let qbClient: IQBittorrentClient;
	let stateManager: IStateManager;
	let consumer: DownloadConsumer;

	beforeEach(() => {
		channel = createMockChannel();
		dlqHandler = createMockDlqHandler();
		qbClient = createMockQBittorrentClient();
		stateManager = createMockStateManager();

		consumer = new DownloadConsumer({
			channel: channel as unknown as Channel,
			exchange: "qbittorrent",
			queue: "downloads.add",
			routingKey: "downloads.add",
			dlqHandler,
			logger: mockLogger,
			prefetchCount: 1,
			qbittorrentClient: qbClient,
			stateManager,
		});
	});

	it("should start and consume messages", async () => {
		// Act
		await consumer.start();

		// Assert
		expect(channel.assertExchange).toHaveBeenCalled();
		expect(channel.assertQueue).toHaveBeenCalled();
		expect(channel.bindQueue).toHaveBeenCalled();
		expect(channel.consume).toHaveBeenCalled();
	});

	it("should add torrent and track hash on valid message", async () => {
		// Arrange
		await consumer.start();

		// Act
		(
			channel as unknown as {
				_simulateMessage: (content: Record<string, unknown>) => void;
			}
		)._simulateMessage({
			id: "req-1",
			magnetLink:
				"magnet:?xt=urn:btih:AABBCCDDEE11223344556677889900AABBCCDDEE",
			category: "sonarr",
		});

		// Wait for async processing
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Assert
		expect(qbClient.addTorrent).toHaveBeenCalled();
		expect(stateManager.addHash).toHaveBeenCalled();
		expect(channel.ack).toHaveBeenCalled();
	});

	it("should send to DLQ when id is missing", async () => {
		// Arrange
		await consumer.start();

		// Act
		(
			channel as unknown as {
				_simulateMessage: (content: Record<string, unknown>) => void;
			}
		)._simulateMessage({
			magnetLink:
				"magnet:?xt=urn:btih:AABBCCDDEE11223344556677889900AABBCCDDEE",
			category: "sonarr",
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		// Assert
		expect(dlqHandler.handleNonRetryableError).toHaveBeenCalled();
	});

	it("should send to DLQ when id is empty string", async () => {
		// Arrange
		await consumer.start();

		// Act
		(
			channel as unknown as {
				_simulateMessage: (content: Record<string, unknown>) => void;
			}
		)._simulateMessage({
			id: "",
			magnetLink:
				"magnet:?xt=urn:btih:AABBCCDDEE11223344556677889900AABBCCDDEE",
			category: "sonarr",
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		// Assert
		expect(dlqHandler.handleNonRetryableError).toHaveBeenCalled();
	});

	it("should send to DLQ when magnetLink is missing", async () => {
		// Arrange
		await consumer.start();

		// Act
		(
			channel as unknown as {
				_simulateMessage: (content: Record<string, unknown>) => void;
			}
		)._simulateMessage({
			id: "req-1",
			category: "sonarr",
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		// Assert
		expect(dlqHandler.handleNonRetryableError).toHaveBeenCalled();
	});

	it("should send to DLQ when magnetLink is not a string", async () => {
		// Arrange
		await consumer.start();

		// Act
		(
			channel as unknown as {
				_simulateMessage: (content: Record<string, unknown>) => void;
			}
		)._simulateMessage({
			id: "req-1",
			magnetLink: 12345,
			category: "sonarr",
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		// Assert
		expect(dlqHandler.handleNonRetryableError).toHaveBeenCalled();
	});

	it("should send to DLQ when magnetLink does not start with magnet:", async () => {
		// Arrange
		await consumer.start();

		// Act
		(
			channel as unknown as {
				_simulateMessage: (content: Record<string, unknown>) => void;
			}
		)._simulateMessage({
			id: "req-1",
			magnetLink: "http://example.com",
			category: "sonarr",
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		// Assert
		expect(dlqHandler.handleNonRetryableError).toHaveBeenCalled();
	});

	it("should send to DLQ when category is invalid", async () => {
		// Arrange
		await consumer.start();

		// Act
		(
			channel as unknown as {
				_simulateMessage: (content: Record<string, unknown>) => void;
			}
		)._simulateMessage({
			id: "req-1",
			magnetLink:
				"magnet:?xt=urn:btih:AABBCCDDEE11223344556677889900AABBCCDDEE",
			category: "invalid",
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		// Assert
		expect(dlqHandler.handleNonRetryableError).toHaveBeenCalled();
	});

	it("should send to DLQ when category is missing", async () => {
		// Arrange
		await consumer.start();

		// Act
		(
			channel as unknown as {
				_simulateMessage: (content: Record<string, unknown>) => void;
			}
		)._simulateMessage({
			id: "req-1",
			magnetLink:
				"magnet:?xt=urn:btih:AABBCCDDEE11223344556677889900AABBCCDDEE",
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		// Assert
		expect(dlqHandler.handleNonRetryableError).toHaveBeenCalled();
	});

	it("should accept radarr category", async () => {
		// Arrange
		await consumer.start();

		// Act
		(
			channel as unknown as {
				_simulateMessage: (content: Record<string, unknown>) => void;
			}
		)._simulateMessage({
			id: "req-2",
			magnetLink:
				"magnet:?xt=urn:btih:AABBCCDDEE11223344556677889900AABBCCDDEE",
			category: "radarr",
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		// Assert
		expect(qbClient.addTorrent).toHaveBeenCalled();
		expect(channel.ack).toHaveBeenCalled();
	});

	it("should accept games category", async () => {
		// Arrange
		await consumer.start();

		// Act
		(
			channel as unknown as {
				_simulateMessage: (content: Record<string, unknown>) => void;
			}
		)._simulateMessage({
			id: "req-3",
			magnetLink:
				"magnet:?xt=urn:btih:AABBCCDDEE11223344556677889900AABBCCDDEE",
			category: "games",
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		// Assert
		expect(qbClient.addTorrent).toHaveBeenCalled();
		expect(channel.ack).toHaveBeenCalled();
	});

	it("should stop consuming on stop", async () => {
		// Arrange
		await consumer.start();

		// Act
		await consumer.stop();

		// Assert
		expect(channel.cancel).toHaveBeenCalledWith("tag-1");
	});
});
