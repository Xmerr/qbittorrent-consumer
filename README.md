# qbittorrent-consumer

RabbitMQ consumer service that manages qBittorrent downloads via the qBittorrent Web API. Listens for `downloads.add` messages to add torrents, polls for download progress, and publishes lifecycle events (`progress`, `complete`, `stalled`, `paused`, `removed`).

Part of the [Consumers](../PRODUCT-CANVAS.md) event-driven microservices platform. Uses [`@xmer/consumer-shared`](https://www.npmjs.com/package/@xmer/consumer-shared) for RabbitMQ infrastructure.

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- RabbitMQ with the [Delayed Message Exchange plugin](https://github.com/rabbitmq/rabbitmq-delayed-message-exchange)
- Redis
- qBittorrent with Web API enabled

### Install

```bash
bun install
```


### Configure

Copy `.env.example` to `.env` and fill in values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RABBITMQ_URL` | Yes | | AMQP connection string |
| `QBITTORRENT_URL` | Yes | | qBittorrent Web API base URL |
| `QBITTORRENT_USERNAME` | Yes | | qBittorrent login username |
| `QBITTORRENT_PASSWORD` | Yes | | qBittorrent login password |
| `REDIS_URL` | Yes | | Redis connection string |
| `QUEUE_NAME` | No | `downloads.add` | RabbitMQ queue name |
| `EXCHANGE_NAME` | No | `qbittorrent` | RabbitMQ exchange name |
| `PROGRESS_INTERVAL_MS` | No | `30000` | Polling interval in milliseconds |
| `LOKI_HOST` | No | | Grafana Loki endpoint for log shipping |
| `LOG_LEVEL` | No | `info` | Log level (`debug`, `info`, `warn`, `error`) |

### Run

```bash
bun run start
```

### Docker

```bash
docker compose up -d
```

The compose file includes a Redis service. The qBittorrent consumer connects to RabbitMQ and qBittorrent externally via environment variables.

## Commands

```bash
bun run start          # Run the service
bun run build          # Compile TypeScript to dist/
bun run lint           # Run Biome linter/formatter
bun run lint:fix       # Auto-fix lint issues
bun test               # Run all tests
bun run test:coverage  # Run tests with coverage report
```

## Data Contracts

Every message includes an `id` field. This is set by the producer in the `downloads.add` request and propagated through all subsequent lifecycle events, allowing downstream consumers to correlate events back to the original request.

### Consumed: `downloads.add`

Published to the `qbittorrent` exchange with routing key `downloads.add`.

```json
{
  "id": "req-abc-123",
  "magnetLink": "magnet:?xt=urn:btih:...",
  "category": "sonarr"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique request identifier. Propagated to all downstream events. Must be a non-empty string. |
| `magnetLink` | `string` | Yes | Magnet URI starting with `magnet:`. Hex (40-char) and base32 (32-char) info hashes are both supported. |
| `category` | `string` | Yes | One of `sonarr`, `radarr`, or `games`. Determines the qBittorrent save category. Invalid values are rejected as non-retryable errors. |

### Published: `downloads.progress`

Emitted every poll interval for each tracked torrent that is actively downloading.

```json
{
  "id": "req-abc-123",
  "hash": "abc123def456...",
  "name": "Example.Torrent.Name",
  "progress": 0.45,
  "downloadSpeed": 5242880,
  "eta": 3600,
  "state": "downloading",
  "category": "sonarr"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Request identifier from the original `downloads.add` message |
| `hash` | `string` | Torrent info hash (lowercase hex) |
| `name` | `string` | Torrent name from qBittorrent |
| `progress` | `number` | Download progress from 0.0 to 1.0 |
| `downloadSpeed` | `number` | Download speed in bytes/second |
| `eta` | `number` | Estimated time remaining in seconds |
| `state` | `string` | qBittorrent state string (e.g., `downloading`, `metaDL`) |
| `category` | `string` | Torrent category |

### Published: `downloads.complete`

Emitted once when a torrent reaches 100% download progress. The torrent is then removed from the tracked set.

```json
{
  "id": "req-abc-123",
  "hash": "abc123def456...",
  "name": "Example.Torrent.Name",
  "size": 1073741824,
  "category": "sonarr"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Request identifier from the original `downloads.add` message |
| `hash` | `string` | Torrent info hash |
| `name` | `string` | Torrent name |
| `size` | `number` | Total size in bytes |
| `category` | `string` | Torrent category |

### Published: `downloads.stalled`

Emitted when a tracked torrent enters the `stalledDL` state. Polling continues.

```json
{
  "id": "req-abc-123",
  "hash": "abc123def456...",
  "name": "Example.Torrent.Name",
  "progress": 0.20,
  "downloadSpeed": 0,
  "eta": 8640000,
  "state": "stalledDL",
  "category": "sonarr"
}
```

Same schema as `downloads.progress`.

### Published: `downloads.paused`

Emitted when a tracked torrent enters the `pausedDL` state. Polling continues.

Same schema as `downloads.progress` with `state: "pausedDL"`.

### Published: `downloads.removed`

Emitted when a tracked torrent is no longer found in qBittorrent (deleted externally). The torrent is removed from the tracked set.

```json
{
  "id": "req-abc-123",
  "hash": "abc123def456...",
  "name": "Example.Torrent.Name",
  "category": "radarr"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Request identifier from the original `downloads.add` message |
| `hash` | `string` | Torrent info hash |
| `name` | `string` | Cached torrent name, or `"unknown"` if not available |
| `category` | `string` | Cached category, or `"unknown"` if not available |

## RabbitMQ Topology

**Exchange**: `qbittorrent` (topic, durable)

| Queue | Binding Key | Direction |
|-------|-------------|-----------|
| `downloads.add` | `downloads.add` | Consumed |
| `downloads.add.dlq` | `downloads.add.dlq` | Dead letter |

All routing keys above (`downloads.progress`, `downloads.complete`, etc.) are published to the `qbittorrent` exchange.

### Exchange-to-Exchange Bindings

The service asserts bindings so specific events are forwarded to the `notifications` exchange:

| Source | Routing Key | Target |
|--------|-------------|--------|
| `qbittorrent` | `downloads.complete` | `notifications` |
| `qbittorrent` | `downloads.removed` | `notifications` |

### Dead Letter Queue

Uses exponential backoff retries via the RabbitMQ Delayed Message Exchange plugin (max 20 retries, capped at 16 hours). After exhaustion, messages land in `downloads.add.dlq` and an alert is published to `notifications` with routing key `notifications.dlq.qbittorrent`.

## Architecture

```
downloads.add ──> DownloadConsumer ──> qBittorrent Web API (add torrent)
(RabbitMQ)              │                        │
                        └─> StateManager         │
                            (Redis Set)          │
                                                 │
                ProgressPublisher ◄── poll ───────┘
                (setInterval)
                        │
                        ├──> downloads.progress
                        ├──> downloads.complete  ──> removes from tracked set
                        ├──> downloads.stalled
                        ├──> downloads.paused
                        └──> downloads.removed   ──> removes from tracked set
```

- **DownloadConsumer** extends `BaseConsumer` — validates messages, adds torrents, tracks hashes
- **ProgressPublisher** extends `BasePublisher` — polls qBittorrent on an interval, publishes state events
- **StateManager** — Redis Set for crash-recoverable hash tracking, in-memory Map for torrent metadata
- **QBittorrentClient** — wraps the qBittorrent Web API with session management and auto re-authentication
