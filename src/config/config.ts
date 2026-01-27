import { ConfigurationError } from "@xmer/consumer-shared";

export class Config {
	readonly rabbitmqUrl: string;
	readonly qbittorrentUrl: string;
	readonly qbittorrentUsername: string;
	readonly qbittorrentPassword: string;
	readonly redisUrl: string;
	readonly queueName: string;
	readonly exchangeName: string;
	readonly progressIntervalMs: number;
	readonly lokiHost: string | undefined;
	readonly logLevel: string;

	constructor(env: Record<string, string | undefined> = process.env) {
		this.rabbitmqUrl = this.requireEnv(env, "RABBITMQ_URL");
		this.qbittorrentUrl = this.requireEnv(env, "QBITTORRENT_URL");
		this.qbittorrentUsername = this.requireEnv(env, "QBITTORRENT_USERNAME");
		this.qbittorrentPassword = this.requireEnv(env, "QBITTORRENT_PASSWORD");
		this.redisUrl = this.requireEnv(env, "REDIS_URL");
		this.queueName = env.QUEUE_NAME ?? "downloads.add";
		this.exchangeName = env.EXCHANGE_NAME ?? "qbittorrent";
		this.progressIntervalMs = Number(env.PROGRESS_INTERVAL_MS ?? "30000");
		this.lokiHost = env.LOKI_HOST;
		this.logLevel = env.LOG_LEVEL ?? "info";
	}

	private requireEnv(
		env: Record<string, string | undefined>,
		key: string,
	): string {
		const value = env[key];
		if (!value) {
			throw new ConfigurationError(
				`Missing required environment variable: ${key}`,
				key,
			);
		}
		return value;
	}
}
