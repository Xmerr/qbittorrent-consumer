import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ILogger } from "@xmer/consumer-shared";
import type { QBittorrentTorrentInfo } from "../types/index.js";
import { StateManager } from "./state-manager.js";

const mockLogger: ILogger = {
	debug: mock(() => {}),
	info: mock(() => {}),
	warn: mock(() => {}),
	error: mock(() => {}),
	child: mock(() => mockLogger),
};

function createMockRedis() {
	return {
		sadd: mock(() => Promise.resolve(1)),
		srem: mock(() => Promise.resolve(1)),
		smembers: mock(() => Promise.resolve([])),
		quit: mock(() => Promise.resolve("OK")),
	};
}

describe("StateManager", () => {
	let stateManager: StateManager;
	let mockRedis: ReturnType<typeof createMockRedis>;

	beforeEach(() => {
		mockRedis = createMockRedis();
		stateManager = new StateManager({
			redis: mockRedis as never,
			logger: mockLogger,
		});
	});

	describe("addHash", () => {
		it("should add hash to Redis set", async () => {
			// Act
			await stateManager.addHash("abc123", {
				id: "req-1",
				name: "",
				category: "sonarr",
			});

			// Assert
			expect(mockRedis.sadd).toHaveBeenCalledWith(
				"qbittorrent-consumer:tracked-torrents",
				"abc123",
			);
		});

		it("should store metadata in memory", async () => {
			// Act
			await stateManager.addHash("abc123", {
				id: "req-1",
				name: "Test",
				category: "radarr",
			});

			// Assert
			expect(stateManager.getMetadata("abc123")).toEqual({
				id: "req-1",
				name: "Test",
				category: "radarr",
			});
		});
	});

	describe("removeHash", () => {
		it("should remove hash from Redis set", async () => {
			// Arrange
			await stateManager.addHash("abc123", {
				id: "req-1",
				name: "",
				category: "sonarr",
			});

			// Act
			await stateManager.removeHash("abc123");

			// Assert
			expect(mockRedis.srem).toHaveBeenCalledWith(
				"qbittorrent-consumer:tracked-torrents",
				"abc123",
			);
		});

		it("should remove metadata from memory", async () => {
			// Arrange
			await stateManager.addHash("abc123", {
				id: "req-1",
				name: "Test",
				category: "sonarr",
			});

			// Act
			await stateManager.removeHash("abc123");

			// Assert
			expect(stateManager.getMetadata("abc123")).toBeUndefined();
		});
	});

	describe("getTrackedHashes", () => {
		it("should return hashes from Redis set", async () => {
			// Arrange
			mockRedis.smembers = mock(() => Promise.resolve(["hash1", "hash2"]));

			// Act
			const hashes = await stateManager.getTrackedHashes();

			// Assert
			expect(hashes).toEqual(["hash1", "hash2"]);
		});
	});

	describe("getMetadata", () => {
		it("should return undefined for unknown hash", () => {
			// Act & Assert
			expect(stateManager.getMetadata("unknown")).toBeUndefined();
		});
	});

	describe("setMetadata", () => {
		it("should set metadata in memory", () => {
			// Act
			stateManager.setMetadata("abc", {
				id: "req-1",
				name: "Test",
				category: "games",
			});

			// Assert
			expect(stateManager.getMetadata("abc")).toEqual({
				id: "req-1",
				name: "Test",
				category: "games",
			});
		});
	});

	describe("loadMetadataFromApi", () => {
		it("should refresh metadata from API response", () => {
			// Arrange
			const torrents: QBittorrentTorrentInfo[] = [
				{
					hash: "h1",
					name: "Torrent 1",
					progress: 0.5,
					dlspeed: 100,
					eta: 60,
					state: "downloading",
					category: "sonarr",
					size: 1024,
				},
				{
					hash: "h2",
					name: "Torrent 2",
					progress: 1.0,
					dlspeed: 0,
					eta: 0,
					state: "uploading",
					category: "radarr",
					size: 2048,
				},
			];

			// Act
			stateManager.loadMetadataFromApi(torrents);

			// Assert
			expect(stateManager.getMetadata("h1")).toEqual({
				id: "",
				name: "Torrent 1",
				category: "sonarr",
			});
			expect(stateManager.getMetadata("h2")).toEqual({
				id: "",
				name: "Torrent 2",
				category: "radarr",
			});
		});
	});

	describe("close", () => {
		it("should quit Redis connection", async () => {
			// Act
			await stateManager.close();

			// Assert
			expect(mockRedis.quit).toHaveBeenCalledTimes(1);
		});
	});
});
