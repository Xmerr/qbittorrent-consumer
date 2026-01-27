import { describe, expect, it } from "bun:test";
import { QBittorrentError } from "./index.js";

describe("QBittorrentError", () => {
	it("should set name to QBittorrentError", () => {
		// Arrange & Act
		const error = new QBittorrentError("test", "ERR_TEST");

		// Assert
		expect(error.name).toBe("QBittorrentError");
	});

	it("should set message and code", () => {
		// Arrange & Act
		const error = new QBittorrentError("Something failed", "ERR_API");

		// Assert
		expect(error.message).toBe("Something failed");
		expect(error.code).toBe("ERR_API");
	});

	it("should store optional context", () => {
		// Arrange
		const context = { endpoint: "/api/v2/auth/login", status: 403 };

		// Act
		const error = new QBittorrentError("Auth failed", "ERR_AUTH", context);

		// Assert
		expect(error.context).toEqual(context);
	});

	it("should default context to undefined", () => {
		// Arrange & Act
		const error = new QBittorrentError("test", "ERR_TEST");

		// Assert
		expect(error.context).toBeUndefined();
	});

	it("should be an instance of Error", () => {
		// Arrange & Act
		const error = new QBittorrentError("test", "ERR_TEST");

		// Assert
		expect(error).toBeInstanceOf(Error);
	});
});
