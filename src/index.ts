import {
	BasePublisher,
	ConnectionManager,
	DlqHandler,
	createLogger,
} from "@xmer/consumer-shared";
import { Redis } from "ioredis";
import { QBittorrentClient } from "./client/qbittorrent-client.js";
import { Config } from "./config/config.js";
import { DownloadConsumer } from "./consumer/download-consumer.js";
import { ProgressPublisher } from "./publisher/progress-publisher.js";
import { StateManager } from "./state/state-manager.js";

async function main(): Promise<void> {
	const config = new Config();

	const logger = createLogger({
		job: "qbittorrent-consumer",
		environment: process.env.NODE_ENV ?? "production",
		level: config.logLevel as "debug" | "info" | "warn" | "error",
		loki: config.lokiHost ? { host: config.lokiHost } : undefined,
	});

	logger.info("Starting qbittorrent-consumer");

	const connectionManager = new ConnectionManager({
		url: config.rabbitmqUrl,
		logger,
	});
	await connectionManager.connect();

	const channel = connectionManager.getChannel();

	const redis = new Redis(config.redisUrl);
	const stateManager = new StateManager({ redis, logger });

	const qbittorrentClient = new QBittorrentClient({
		baseUrl: config.qbittorrentUrl,
		username: config.qbittorrentUsername,
		password: config.qbittorrentPassword,
		logger,
	});
	await qbittorrentClient.login();

	const notificationsPublisher = new BasePublisher({
		channel,
		exchange: "notifications",
		logger,
	});

	const progressPublisher = new ProgressPublisher({
		channel,
		exchange: config.exchangeName,
		logger,
		qbittorrentClient,
		stateManager,
		intervalMs: config.progressIntervalMs,
		notificationsPublisher,
	});

	const dlqHandler = new DlqHandler({
		channel,
		exchange: config.exchangeName,
		queue: config.queueName,
		serviceName: "qbittorrent",
		logger,
	});

	const consumer = new DownloadConsumer({
		channel,
		exchange: config.exchangeName,
		queue: config.queueName,
		routingKey: "downloads.add",
		dlqHandler,
		logger,
		prefetchCount: 1,
		qbittorrentClient,
		stateManager,
	});

	await consumer.start();

	// Assert exchange-to-exchange bindings for notifications
	// Must run after consumer.start() which asserts the qbittorrent exchange
	await channel.assertExchange("notifications", "topic", { durable: true });
	await channel.bindExchange(
		"notifications",
		config.exchangeName,
		"downloads.complete",
	);
	await channel.bindExchange(
		"notifications",
		config.exchangeName,
		"downloads.removed",
	);
	logger.info("Exchange-to-exchange bindings asserted");

	progressPublisher.startPolling();

	logger.info("qbittorrent-consumer is running");

	const shutdown = async (): Promise<void> => {
		logger.info("Shutting down...");
		await consumer.stop();
		progressPublisher.stopPolling();
		await new Promise((resolve) => setTimeout(resolve, 2000));
		await connectionManager.close();
		await stateManager.close();
		logger.info("Shutdown complete");
		process.exit(0);
	};

	process.on("SIGTERM", () => void shutdown());
	process.on("SIGINT", () => void shutdown());
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
