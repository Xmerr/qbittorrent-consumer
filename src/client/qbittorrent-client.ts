import { NonRetryableError, RetryableError } from "consumer-shared";
import type { ILogger } from "consumer-shared";
import { QBittorrentError } from "../errors/index.js";
import type {
	IQBittorrentClient,
	QBittorrentClientOptions,
	QBittorrentTorrentInfo,
} from "../types/index.js";

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export class QBittorrentClient implements IQBittorrentClient {
	private readonly baseUrl: string;
	private readonly username: string;
	private readonly password: string;
	private readonly logger: ILogger;
	private sid: string | null = null;

	constructor(options: QBittorrentClientOptions) {
		this.baseUrl = options.baseUrl;
		this.username = options.username;
		this.password = options.password;
		this.logger = options.logger.child({ component: "QBittorrentClient" });
	}

	async login(): Promise<void> {
		const body = new URLSearchParams({
			username: this.username,
			password: this.password,
		});

		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}/api/v2/auth/login`, {
				method: "POST",
				body,
			});
		} catch (error) {
			throw new RetryableError(
				`Failed to connect to qBittorrent: ${(error as Error).message}`,
				"ERR_QBITTORRENT_CONNECTION",
			);
		}

		if (!response.ok) {
			throw new QBittorrentError("Login request failed", "ERR_LOGIN_FAILED", {
				status: response.status,
			});
		}

		const text = await response.text();
		if (text !== "Ok.") {
			throw new NonRetryableError(
				"Invalid qBittorrent credentials",
				"ERR_INVALID_CREDENTIALS",
			);
		}

		const setCookie = response.headers.get("set-cookie");
		const sidMatch = setCookie?.match(/SID=([^;]+)/);
		if (!sidMatch?.[1]) {
			throw new QBittorrentError(
				"No SID cookie in login response",
				"ERR_NO_SID",
			);
		}

		this.sid = sidMatch[1];
		this.logger.info("Logged in to qBittorrent");
	}

	async addTorrent(magnetLink: string, category: string): Promise<string> {
		const hash = extractHash(magnetLink);

		const body = new URLSearchParams({
			urls: magnetLink,
			category,
		});

		const response = await this.authenticatedFetch("/api/v2/torrents/add", {
			method: "POST",
			body,
		});

		if (!response.ok) {
			throw new RetryableError(
				`Failed to add torrent: HTTP ${response.status}`,
				"ERR_ADD_TORRENT",
				{ status: response.status },
			);
		}

		this.logger.info("Torrent added", { hash, category });
		return hash;
	}

	async getTorrentsInfo(hashes: string[]): Promise<QBittorrentTorrentInfo[]> {
		const hashesParam = hashes.join("|");
		const response = await this.authenticatedFetch(
			`/api/v2/torrents/info?hashes=${hashesParam}`,
			{ method: "GET" },
		);

		if (!response.ok) {
			throw new RetryableError(
				`Failed to get torrents info: HTTP ${response.status}`,
				"ERR_GET_TORRENTS",
				{ status: response.status },
			);
		}

		return (await response.json()) as QBittorrentTorrentInfo[];
	}

	private async authenticatedFetch(
		path: string,
		init: RequestInit,
	): Promise<Response> {
		if (!this.sid) {
			await this.login();
		}

		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}${path}`, {
				...init,
				headers: {
					...((init.headers as Record<string, string>) ?? {}),
					Cookie: `SID=${this.sid}`,
				},
			});
		} catch (error) {
			throw new RetryableError(
				`qBittorrent request failed: ${(error as Error).message}`,
				"ERR_QBITTORRENT_CONNECTION",
			);
		}

		if (response.status === 403) {
			this.logger.warn("Session expired, re-authenticating");
			this.sid = null;
			await this.login();
			try {
				return await fetch(`${this.baseUrl}${path}`, {
					...init,
					headers: {
						...((init.headers as Record<string, string>) ?? {}),
						Cookie: `SID=${this.sid}`,
					},
				});
			} catch (error) {
				throw new RetryableError(
					`qBittorrent request failed after re-auth: ${(error as Error).message}`,
					"ERR_QBITTORRENT_CONNECTION",
				);
			}
		}

		return response;
	}
}

export function extractHash(magnetLink: string): string {
	if (!magnetLink.startsWith("magnet:")) {
		throw new NonRetryableError(
			"Invalid magnet link: must start with 'magnet:'",
			"ERR_INVALID_MAGNET",
		);
	}

	const match = magnetLink.match(/xt=urn:btih:([a-zA-Z0-9]+)/);
	if (!match?.[1]) {
		throw new NonRetryableError(
			"Invalid magnet link: no btih hash found",
			"ERR_INVALID_MAGNET",
		);
	}

	const raw = match[1];

	if (raw.length === 40) {
		return raw.toLowerCase();
	}

	if (raw.length === 32) {
		return base32ToHex(raw.toUpperCase());
	}

	throw new NonRetryableError(
		`Invalid magnet link: unexpected hash length ${raw.length}`,
		"ERR_INVALID_MAGNET",
	);
}

function base32ToHex(base32: string): string {
	let bits = "";
	for (const char of base32) {
		const index = BASE32_CHARS.indexOf(char);
		if (index === -1) {
			throw new NonRetryableError(
				`Invalid base32 character: ${char}`,
				"ERR_INVALID_MAGNET",
			);
		}
		bits += index.toString(2).padStart(5, "0");
	}

	let hex = "";
	for (let i = 0; i + 4 <= bits.length; i += 4) {
		hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
	}

	return hex.toLowerCase();
}
