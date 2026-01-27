import { describe, expect, it } from "bun:test";
import { ConfigurationError } from "@xmer/consumer-shared";
import { Config } from "./config.js";

const validEnv: Record<string, string> = {
	RABBITMQ_URL: "amqp://user:pass@host:5672",
	QBITTORRENT_URL: "http://localhost:8080",
	QBITTORRENT_USERNAME: "admin",
	QBITTORRENT_PASSWORD: "secret",
	REDIS_URL: "redis://localhost:6379",
};

describe("Config", () => {
	it("should parse all required environment variables", () => {
		// Arrange & Act
		const config = new Config(validEnv);

		// Assert
		expect(config.rabbitmqUrl).toBe("amqp://user:pass@host:5672");
		expect(config.qbittorrentUrl).toBe("http://localhost:8080");
		expect(config.qbittorrentUsername).toBe("admin");
		expect(config.qbittorrentPassword).toBe("secret");
		expect(config.redisUrl).toBe("redis://localhost:6379");
	});

	it("should use default values for optional variables", () => {
		// Arrange & Act
		const config = new Config(validEnv);

		// Assert
		expect(config.queueName).toBe("downloads.add");
		expect(config.exchangeName).toBe("qbittorrent");
		expect(config.progressIntervalMs).toBe(30000);
		expect(config.lokiHost).toBeUndefined();
		expect(config.logLevel).toBe("info");
	});

	it("should use provided optional values when set", () => {
		// Arrange
		const env = {
			...validEnv,
			QUEUE_NAME: "custom.queue",
			EXCHANGE_NAME: "custom-exchange",
			PROGRESS_INTERVAL_MS: "5000",
			LOKI_HOST: "http://loki:3100",
			LOG_LEVEL: "debug",
		};

		// Act
		const config = new Config(env);

		// Assert
		expect(config.queueName).toBe("custom.queue");
		expect(config.exchangeName).toBe("custom-exchange");
		expect(config.progressIntervalMs).toBe(5000);
		expect(config.lokiHost).toBe("http://loki:3100");
		expect(config.logLevel).toBe("debug");
	});

	it("should throw ConfigurationError when RABBITMQ_URL is missing", () => {
		// Arrange
		const { RABBITMQ_URL: _, ...env } = validEnv;

		// Act & Assert
		expect(() => new Config(env)).toThrow(ConfigurationError);
	});

	it("should throw ConfigurationError when QBITTORRENT_URL is missing", () => {
		// Arrange
		const { QBITTORRENT_URL: _, ...env } = validEnv;

		// Act & Assert
		expect(() => new Config(env)).toThrow(ConfigurationError);
	});

	it("should throw ConfigurationError when QBITTORRENT_USERNAME is missing", () => {
		// Arrange
		const { QBITTORRENT_USERNAME: _, ...env } = validEnv;

		// Act & Assert
		expect(() => new Config(env)).toThrow(ConfigurationError);
	});

	it("should throw ConfigurationError when QBITTORRENT_PASSWORD is missing", () => {
		// Arrange
		const { QBITTORRENT_PASSWORD: _, ...env } = validEnv;

		// Act & Assert
		expect(() => new Config(env)).toThrow(ConfigurationError);
	});

	it("should throw ConfigurationError when REDIS_URL is missing", () => {
		// Arrange
		const { REDIS_URL: _, ...env } = validEnv;

		// Act & Assert
		expect(() => new Config(env)).toThrow(ConfigurationError);
	});

	it("should include field name in ConfigurationError", () => {
		// Arrange
		const { RABBITMQ_URL: _, ...env } = validEnv;

		// Act & Assert
		try {
			new Config(env);
			expect.unreachable("Should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigurationError);
			expect((error as ConfigurationError).field).toBe("RABBITMQ_URL");
		}
	});
});
