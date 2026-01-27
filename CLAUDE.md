# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RabbitMQ consumer service that manages qBittorrent downloads via the qBittorrent Web API. Listens for `downloads.add` messages to add torrents, then broadcasts download progress at regular intervals and emits completion/status events. Part of the [Consumers](../PRODUCT-CANVAS.md) event-driven microservices platform.

Uses [`consumer-shared`](../consumer-shared/) for RabbitMQ connection management, base consumer/publisher abstractions, DLQ retry logic, logging, and common error classes.

## Commands

```bash
bun run build          # Compile TypeScript to dist/
bun run lint           # Run Biome linter/formatter
bun run lint:fix       # Auto-fix lint issues
bun test               # Run all tests
bun run test:coverage  # Run tests with coverage (95% threshold)
bun run start          # Run service (requires .env file)
```

Run a single test file:
```bash
bun test src/config/config.test.ts
```

Run tests matching a pattern:
```bash
bun test --grep "should add"
```

## Architecture

```
Message Flow:

                        ┌──────────────────────┐
downloads.add ─────────▶│  qBittorrent         │──────▶ downloads.progress
(RabbitMQ)              │  Consumer            │──────▶ downloads.complete
                        └──────┬───────────────┘──────▶ downloads.stalled
                               │                ──────▶ downloads.paused
                               ▼                ──────▶ downloads.removed
                        qBittorrent Web API            (RabbitMQ)
                        (add torrent, poll status)
```

### Key Components

- **`src/index.ts`**: Service orchestration. Wires together all dependencies (shared and service-specific), starts the consumer, and registers graceful shutdown handlers (SIGTERM/SIGINT).

- **`src/consumer/download-consumer.ts`**: Extends `BaseConsumer` from `consumer-shared`. Implements `processMessage()` to handle `downloads.add` messages — delegates to the qBittorrent client to add torrents, then stores the torrent hash in the state manager. Message acknowledgment and DLQ routing are handled by the base class.

- **`src/client/qbittorrent-client.ts`**: Wraps the qBittorrent Web API. Handles authentication, adding torrents (magnet links), and querying torrent status/progress. Implements `IQBittorrentClient`.

- **`src/publisher/progress-publisher.ts`**: Extends `BasePublisher` from `consumer-shared`. Runs on a configurable interval, polls qBittorrent for tracked download status, and publishes messages to the appropriate routing key. Emits `downloads.complete` when a torrent reaches 100% download progress. Reports `downloads.stalled` and `downloads.paused` states but continues polling until the torrent is deleted from qBittorrent or reaches 100%.

- **`src/state/state-manager.ts`**: Redis-backed state persistence. Stores the set of tracked torrent hashes so the service can resume polling after restart without losing track of in-progress downloads. Implements `IStateManager`.

- **`src/config/config.ts`**: Environment variable parsing with validation. All config accessed through `Config` class getters.

### Dependency Injection Pattern

Components receive dependencies via constructor options. Shared infrastructure is imported from `consumer-shared`:

```typescript
import {
  ConnectionManager,
  DlqHandler,
  createLogger,
} from "consumer-shared";

const consumer = new DownloadConsumer({
  connectionManager,  // ConnectionManager (from consumer-shared)
  logger,            // ILogger (from consumer-shared)
  dlqHandler,        // DlqHandler (from consumer-shared)
  qbittorrentClient, // IQBittorrentClient (service-specific)
  publisher,         // ProgressPublisher (service-specific)
  stateManager,      // IStateManager (service-specific)
});
```

### Custom Errors

Service-specific errors in `src/errors/`:
- `QBittorrentError`: qBittorrent API failures (includes HTTP status, endpoint)

Base error classes (`RetryableError`, `NonRetryableError`, `ConnectionError`, `ConfigurationError`) are imported from `consumer-shared`.

## RabbitMQ Topology

### Exchange

- **Name**: `qbittorrent`
- **Type**: `topic`
- **Durable**: `true`

Topic exchange allows other services to subscribe to specific routing keys (e.g., only `downloads.complete`) or use wildcards (e.g., `downloads.*` for all download events, `#` for everything).

### Queue Bindings

| Queue | Binding Key | Purpose |
|-------|------------|---------|
| `downloads.add` | `downloads.add` | Incoming download requests |
| `downloads.add.dlq` | `downloads.add.dlq` | Failed messages after retry exhaustion |

### Routing Keys (Published)

| Routing Key | When |
|------------|------|
| `downloads.progress` | Every poll interval for each tracked torrent |
| `downloads.complete` | When a tracked torrent reaches 100% download |
| `downloads.stalled` | When a tracked torrent enters a stalled state |
| `downloads.paused` | When a tracked torrent is paused |
| `downloads.removed` | When a tracked torrent is deleted from qBittorrent externally |

### Prefetch Count

Set to `1`. Each message triggers a qBittorrent API call (add torrent), so sequential processing prevents overwhelming the qBittorrent API. Higher prefetch would add complexity with minimal throughput benefit for this workload.

### Dead Letter Queue (DLQ)

Uses `DlqHandler` from `consumer-shared` with the platform DLQ standard:

- **DLQ queue**: `downloads.add.dlq`
- **Delayed exchange**: `qbittorrent.delay`
- **DLQ alerting routing key**: `notifications.dlq.qbittorrent`

## Message Contracts

All messages include an `id` field set by the producer in the `downloads.add` request. This `id` is propagated through every subsequent lifecycle event so downstream consumers can correlate events to the original request.

### Consumed: `downloads.add`

```json
{
  "id": "req-abc-123",
  "magnetLink": "magnet:?xt=urn:btih:...",
  "category": "sonarr"
}
```

- `id` (required): Unique request identifier. Propagated to all downstream events. Must be a non-empty string.
- `magnetLink` (required): Magnet URI for the torrent
- `category` (required): One of `"sonarr"`, `"radarr"`, or `"games"`. Determines the qBittorrent category (and therefore save path). Any other value is a non-retryable error -> DLQ.

### Produced: `downloads.progress`

```json
{
  "id": "req-abc-123",
  "hash": "abc123",
  "name": "Example.Torrent",
  "progress": 0.45,
  "downloadSpeed": 5242880,
  "eta": 3600,
  "state": "downloading",
  "category": "sonarr"
}
```

### Produced: `downloads.complete`

```json
{
  "id": "req-abc-123",
  "hash": "abc123",
  "name": "Example.Torrent",
  "size": 1073741824,
  "category": "sonarr"
}
```

### Produced: `downloads.removed`

```json
{
  "id": "req-abc-123",
  "hash": "abc123",
  "name": "Example.Torrent",
  "category": "radarr"
}
```

Published when a tracked torrent is no longer found in qBittorrent (deleted externally). The torrent is removed from the tracked set after publishing.

## Torrent Tracking

This service **only tracks torrents it adds** via `downloads.add` messages. It does not monitor pre-existing or externally-added torrents.

### Lifecycle

1. `downloads.add` message received -> torrent added to qBittorrent -> torrent hash stored in Redis
2. Each poll interval: query qBittorrent for all tracked hashes -> publish `downloads.progress` for each
3. If torrent reaches 100% download -> publish `downloads.complete` -> remove from tracked set
4. If torrent is deleted from qBittorrent externally -> publish `downloads.removed` -> remove from tracked set (detected on next poll when the hash is no longer found)
5. Stalled/paused states are reported via `downloads.stalled`/`downloads.paused` but polling continues -- the torrent stays in the tracked set

### Polling Failure Handling

When the qBittorrent API is unreachable during a poll cycle, the publisher logs a warning and skips that cycle. The poll interval is short enough that occasional failures are harmless. However, if polling fails continuously for **10 minutes**, the publisher sends a notification to the `notifications` exchange with routing key `notifications.polling.failure` to alert that qBittorrent may be down. The 10-minute alert is sent once and resets when a poll succeeds.

### State Persistence (Redis)

Tracked torrent hashes are stored in a Redis set so the service can resume polling after restart.

- **Redis key**: `qbittorrent-consumer:tracked-torrents` (Set type)
- **SADD**: When a torrent is successfully added to qBittorrent
- **SREM**: When a torrent reaches 100% or is deleted from qBittorrent
- **SMEMBERS**: On startup, to reload the tracked set

## Graceful Shutdown

On SIGTERM or SIGINT:

1. Stop accepting new messages (cancel RabbitMQ consumer)
2. Stop the progress polling timer
3. Wait for any in-flight message processing to complete
4. Close RabbitMQ connection (via `ConnectionManager.close()`)
5. Close Redis connection
6. Exit process

## Testing

Uses Bun's built-in test runner. Tests use the arrange-act-assert pattern.

Mocking pattern for shared dependencies:
```typescript
import { describe, it, expect, mock } from "bun:test";
import type { ILogger } from "consumer-shared";

const mockLogger: ILogger = {
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  child: mock(() => mockLogger),
};
```

The qBittorrent Web API client, Redis client, and all `consumer-shared` components must be fully mocked in tests -- no real HTTP calls, Redis connections, or RabbitMQ connections.

## TypeScript

- ESM modules with `.js` extensions in imports
- Strict mode enabled with `noUncheckedIndexedAccess`
- Service-specific interfaces in `src/types/index.ts`
- Shared interfaces imported from `consumer-shared`

## Dependencies

### Shared (from `consumer-shared`)
- `ConnectionManager` -- RabbitMQ connection lifecycle
- `BaseConsumer` -- message consumption, ack/nack, DLQ routing
- `BasePublisher` -- exchange publishing
- `DlqHandler` -- retry logic with delayed exchange
- `createLogger` / `ILogger` -- Pino logger with Loki transport
- `RetryableError`, `NonRetryableError`, `ConnectionError`, `ConfigurationError` -- base error classes

### Service-specific
- `ioredis` -- Redis client for state persistence
- qBittorrent Web API (via `fetch`)

## Environment Variables

Required: `RABBITMQ_URL`, `QBITTORRENT_URL`, `QBITTORRENT_USERNAME`, `QBITTORRENT_PASSWORD`, `REDIS_URL`

Optional: `QUEUE_NAME` (default: `downloads.add`), `EXCHANGE_NAME` (default: `qbittorrent`), `PROGRESS_INTERVAL_MS` (default: `30000`), `LOKI_HOST`, `LOG_LEVEL`

See `.env.example` for all options.

## Infrastructure

- **Redis**: `192.168.0.100:6379` (not yet running -- needs compose setup)
- **qBittorrent**: `192.168.0.100:8123` (Web API enabled)

## Exchange-to-Exchange Bindings

This service asserts exchange-to-exchange bindings on startup so that specific events published to the `qbittorrent` exchange are forwarded to the `notifications` exchange automatically. This decouples the qbittorrent consumer from the notification service -- it publishes domain events without knowing who consumes them.

| Source Exchange | Routing Key | Target Exchange |
|----------------|-------------|-----------------|
| `qbittorrent` | `downloads.complete` | `notifications` |
| `qbittorrent` | `downloads.removed` | `notifications` |

These bindings are asserted via `channel.bindExchange('notifications', 'qbittorrent', routingKey)`.

## Notes

- Progress broadcasting runs on a timer interval, not per-message
- Only torrents added by this service are tracked (via Redis set)
- Completion = 100% download progress (not based on seeding state)
- Stalled and paused torrents are reported but continue to be polled
- `category` must be one of: `sonarr`, `radarr`, `games` -- other values are rejected as non-retryable errors
