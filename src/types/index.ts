import type { Channel } from "amqplib";
import type { ILogger } from "consumer-shared";
import type { Redis } from "ioredis";

// ── Torrent categories ──

export type TorrentCategory = "sonarr" | "radarr" | "games";

export const VALID_CATEGORIES: ReadonlySet<string> = new Set<TorrentCategory>([
	"sonarr",
	"radarr",
	"games",
]);

// ── Message contracts ──

export interface DownloadAddMessage {
	id: string;
	magnetLink: string;
	category: TorrentCategory;
}

export interface DownloadProgressMessage {
	id: string;
	hash: string;
	name: string;
	progress: number;
	downloadSpeed: number;
	eta: number;
	state: string;
	category: string;
}

export interface DownloadCompleteMessage {
	id: string;
	hash: string;
	name: string;
	size: number;
	category: string;
}

export interface DownloadRemovedMessage {
	id: string;
	hash: string;
	name: string;
	category: string;
}

// ── qBittorrent API response ──

export interface QBittorrentTorrentInfo {
	hash: string;
	name: string;
	progress: number;
	dlspeed: number;
	eta: number;
	state: string;
	category: string;
	size: number;
}

// ── Service interfaces ──

export interface IQBittorrentClient {
	login(): Promise<void>;
	addTorrent(magnetLink: string, category: string): Promise<string>;
	getTorrentsInfo(hashes: string[]): Promise<QBittorrentTorrentInfo[]>;
}

export interface TorrentMetadata {
	id: string;
	name: string;
	category: string;
}

export interface IStateManager {
	addHash(hash: string, metadata: TorrentMetadata): Promise<void>;
	removeHash(hash: string): Promise<void>;
	getTrackedHashes(): Promise<string[]>;
	getMetadata(hash: string): TorrentMetadata | undefined;
	setMetadata(hash: string, metadata: TorrentMetadata): void;
	loadMetadataFromApi(torrents: QBittorrentTorrentInfo[]): void;
	close(): Promise<void>;
}

export interface IProgressPublisher {
	startPolling(): void;
	stopPolling(): void;
}

// ── Options interfaces ──

export interface QBittorrentClientOptions {
	baseUrl: string;
	username: string;
	password: string;
	logger: ILogger;
}

export interface StateManagerOptions {
	redis: Redis;
	logger: ILogger;
}

export interface DownloadConsumerOptions {
	channel: Channel;
	exchange: string;
	queue: string;
	routingKey: string;
	dlqHandler: import("consumer-shared").IDlqHandler;
	logger: ILogger;
	prefetchCount?: number;
	qbittorrentClient: IQBittorrentClient;
	stateManager: IStateManager;
}

export interface ProgressPublisherOptions {
	channel: Channel;
	exchange: string;
	logger: ILogger;
	qbittorrentClient: IQBittorrentClient;
	stateManager: IStateManager;
	intervalMs: number;
	notificationsPublisher: import("consumer-shared").IPublisher;
}
