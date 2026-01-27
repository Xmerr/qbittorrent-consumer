import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { NonRetryableError, RetryableError } from "consumer-shared";
import type { ILogger } from "consumer-shared";
import { QBittorrentError } from "../errors/index.js";
import { QBittorrentClient, extractHash } from "./qbittorrent-client.js";

const mockLogger: ILogger = {
	debug: mock(() => {}),
	info: mock(() => {}),
	warn: mock(() => {}),
	error: mock(() => {}),
	child: mock(() => mockLogger),
};

const originalFetch = globalThis.fetch;

describe("extractHash", () => {
	it("should extract a 40-char hex hash and lowercase it", () => {
		// Arrange
		const magnet =
			"magnet:?xt=urn:btih:AABBCCDDEE11223344556677889900AABBCCDDEE&dn=test";

		// Act
		const hash = extractHash(magnet);

		// Assert
		expect(hash).toBe("aabbccddee11223344556677889900aabbccddee");
	});

	it("should convert a 32-char base32 hash to lowercase hex", () => {
		// Arrange
		const magnet =
			"magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=test";

		// Act
		const hash = extractHash(magnet);

		// Assert
		expect(hash).toBe("0000000000000000000000000000000000000000");
	});

	it("should throw NonRetryableError for non-magnet links", () => {
		// Act & Assert
		expect(() => extractHash("http://example.com")).toThrow(NonRetryableError);
	});

	it("should throw NonRetryableError when no btih hash found", () => {
		// Act & Assert
		expect(() => extractHash("magnet:?dn=test")).toThrow(NonRetryableError);
	});

	it("should throw NonRetryableError for unexpected hash length", () => {
		// Act & Assert
		expect(() => extractHash("magnet:?xt=urn:btih:abc")).toThrow(
			NonRetryableError,
		);
	});
});

describe("QBittorrentClient", () => {
	let client: QBittorrentClient;

	beforeEach(() => {
		client = new QBittorrentClient({
			baseUrl: "http://localhost:8080",
			username: "admin",
			password: "secret",
			logger: mockLogger,
		});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	describe("login", () => {
		it("should login and extract SID cookie", async () => {
			// Arrange
			globalThis.fetch = mock(() =>
				Promise.resolve(
					new Response("Ok.", {
						status: 200,
						headers: { "set-cookie": "SID=test-sid-123; Path=/" },
					}),
				),
			);

			// Act
			await client.login();

			// Assert
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		});

		it("should throw RetryableError on network failure", async () => {
			// Arrange
			globalThis.fetch = mock(() =>
				Promise.reject(new Error("Connection refused")),
			);

			// Act & Assert
			await expect(client.login()).rejects.toThrow(RetryableError);
		});

		it("should throw QBittorrentError on non-ok response", async () => {
			// Arrange
			globalThis.fetch = mock(() =>
				Promise.resolve(new Response("Error", { status: 500 })),
			);

			// Act & Assert
			await expect(client.login()).rejects.toThrow(QBittorrentError);
		});

		it("should throw NonRetryableError on invalid credentials", async () => {
			// Arrange
			globalThis.fetch = mock(() =>
				Promise.resolve(
					new Response("Fails.", {
						status: 200,
						headers: { "set-cookie": "" },
					}),
				),
			);

			// Act & Assert
			await expect(client.login()).rejects.toThrow(NonRetryableError);
		});

		it("should throw QBittorrentError when no SID in cookie", async () => {
			// Arrange
			globalThis.fetch = mock(() =>
				Promise.resolve(
					new Response("Ok.", {
						status: 200,
						headers: { "set-cookie": "other=value" },
					}),
				),
			);

			// Act & Assert
			await expect(client.login()).rejects.toThrow(QBittorrentError);
		});
	});

	describe("addTorrent", () => {
		it("should add torrent and return hash", async () => {
			// Arrange
			let callCount = 0;
			globalThis.fetch = mock(() => {
				callCount++;
				if (callCount === 1) {
					return Promise.resolve(
						new Response("Ok.", {
							status: 200,
							headers: { "set-cookie": "SID=sid-123; Path=/" },
						}),
					);
				}
				return Promise.resolve(new Response("Ok.", { status: 200 }));
			});

			const magnet =
				"magnet:?xt=urn:btih:AABBCCDDEE11223344556677889900AABBCCDDEE&dn=test";

			// Act
			const hash = await client.addTorrent(magnet, "sonarr");

			// Assert
			expect(hash).toBe("aabbccddee11223344556677889900aabbccddee");
		});

		it("should throw RetryableError on non-ok response", async () => {
			// Arrange
			let callCount = 0;
			globalThis.fetch = mock(() => {
				callCount++;
				if (callCount === 1) {
					return Promise.resolve(
						new Response("Ok.", {
							status: 200,
							headers: { "set-cookie": "SID=sid-123; Path=/" },
						}),
					);
				}
				return Promise.resolve(new Response("Server Error", { status: 500 }));
			});

			const magnet =
				"magnet:?xt=urn:btih:AABBCCDDEE11223344556677889900AABBCCDDEE&dn=test";

			// Act & Assert
			await expect(client.addTorrent(magnet, "sonarr")).rejects.toThrow(
				RetryableError,
			);
		});
	});

	describe("getTorrentsInfo", () => {
		it("should return torrent info for given hashes", async () => {
			// Arrange
			const torrents = [
				{
					hash: "abc123",
					name: "Test",
					progress: 0.5,
					dlspeed: 1000,
					eta: 60,
					state: "downloading",
					category: "sonarr",
					size: 1024,
				},
			];
			let callCount = 0;
			globalThis.fetch = mock(() => {
				callCount++;
				if (callCount === 1) {
					return Promise.resolve(
						new Response("Ok.", {
							status: 200,
							headers: { "set-cookie": "SID=sid-123; Path=/" },
						}),
					);
				}
				return Promise.resolve(
					new Response(JSON.stringify(torrents), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);
			});

			// Act
			const result = await client.getTorrentsInfo(["abc123"]);

			// Assert
			expect(result).toEqual(torrents);
		});

		it("should join multiple hashes with pipe separator", async () => {
			// Arrange
			let capturedUrl = "";
			let callCount = 0;
			globalThis.fetch = mock((url: string) => {
				callCount++;
				if (callCount === 1) {
					return Promise.resolve(
						new Response("Ok.", {
							status: 200,
							headers: { "set-cookie": "SID=sid-123; Path=/" },
						}),
					);
				}
				capturedUrl = url;
				return Promise.resolve(
					new Response(JSON.stringify([]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);
			});

			// Act
			await client.getTorrentsInfo(["hash1", "hash2", "hash3"]);

			// Assert
			expect(capturedUrl).toContain("hashes=hash1|hash2|hash3");
		});

		it("should throw RetryableError on non-ok response", async () => {
			// Arrange
			let callCount = 0;
			globalThis.fetch = mock(() => {
				callCount++;
				if (callCount === 1) {
					return Promise.resolve(
						new Response("Ok.", {
							status: 200,
							headers: { "set-cookie": "SID=sid-123; Path=/" },
						}),
					);
				}
				return Promise.resolve(new Response("Error", { status: 500 }));
			});

			// Act & Assert
			await expect(client.getTorrentsInfo(["abc"])).rejects.toThrow(
				RetryableError,
			);
		});
	});

	describe("authenticatedFetch re-auth on 403", () => {
		it("should re-login and retry on 403 response", async () => {
			// Arrange
			let callCount = 0;
			globalThis.fetch = mock(() => {
				callCount++;
				if (callCount === 1) {
					// Initial login
					return Promise.resolve(
						new Response("Ok.", {
							status: 200,
							headers: { "set-cookie": "SID=sid-old; Path=/" },
						}),
					);
				}
				if (callCount === 2) {
					// First request returns 403
					return Promise.resolve(new Response("Forbidden", { status: 403 }));
				}
				if (callCount === 3) {
					// Re-login
					return Promise.resolve(
						new Response("Ok.", {
							status: 200,
							headers: { "set-cookie": "SID=sid-new; Path=/" },
						}),
					);
				}
				// Retry succeeds
				return Promise.resolve(
					new Response(JSON.stringify([]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);
			});

			// Act
			const result = await client.getTorrentsInfo(["abc"]);

			// Assert
			expect(result).toEqual([]);
			expect(callCount).toBe(4);
		});
	});
});
