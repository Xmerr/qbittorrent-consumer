# Product Canvas: qBittorrent Consumer

> Last updated: 2026-01-26
> Status: Active

## Overview

**One-liner:** A RabbitMQ consumer that bridges qBittorrent into an event-driven ecosystem, turning an isolated download client into a reactive service that accepts commands and broadcasts lifecycle events.

---

## Target User

**Primary Persona:** Solo developer / self-hoster (yourself)

| Attribute | Value |
|-----------|-------|
| Skill Level | Expert |
| Key Frustration | qBittorrent is an island — no event system, no way for other services to react to download state changes |
| Current Solution | Manually checking qBittorrent UI, no programmatic integration between download client and notification/automation pipeline |
| Frequency of Problem | Daily |

**User Quote (representative):**
> "qBittorrent does its job, but nothing else knows what it's doing. I want downloads to be a first-class event source so the rest of my infrastructure can react."

---

## Core Problem

**Problem Statement:**
qBittorrent operates as a closed system with no native event emission capability. Other services in the home infrastructure stack (notifications, automation, monitoring) have no way to know when a download is added, progressing, or complete. This forces manual monitoring and prevents building reactive workflows around download lifecycle events.

**Problem Severity:**
| Dimension | Rating |
|-----------|--------|
| Frequency | Daily |
| Impact | Painful |
| Urgency | Important |

**What happens if unsolved:**
Downloads happen in a black box. Completion events are missed, progress is invisible to other services, and there's no audit trail of download activity. Every downstream action (notification, file processing, library refresh) requires manual intervention or polling from the outside.

---

## Value Proposition

**Why us:**
Purpose-built event bridge that gives qBittorrent a voice in a RabbitMQ-based ecosystem, with zero changes to qBittorrent itself.

**Key Differentiators:**
1. **Event bridge pattern** — Translates qBittorrent's poll-only API into push-based RabbitMQ events, making downloads observable by any consumer
2. **Full lifecycle tracking** — Covers the complete journey: magnet received, torrent added, progress broadcast, completion detected, external removal detected
3. **Zero coupling** — qBittorrent runs untouched; this service sits alongside it and bridges the gap via the Web API

**Alternatives & Why We're Better:**
| Alternative | Their Weakness | Our Strength |
|-------------|----------------|--------------|
| Sonarr/Radarr hooks | Tightly coupled to media management, only fires for their own downloads | Works for any torrent added via RabbitMQ, media-agnostic |
| qBittorrent RSS/plugins | Limited to qBittorrent's plugin ecosystem, no external event system | Produces standard RabbitMQ messages consumable by any service |
| Manual polling scripts | Fragile, no message guarantees, no DLQ, no structured events | Production-grade consumer with reconnection, error handling, and structured message contracts |

---

## Success Metrics

**North Star Metric:** End-to-end tracking completeness — every download added via message is tracked through to a completion event with zero silent failures.

| Metric | Current | 6-Month Target | Why It Matters |
|--------|---------|----------------|----------------|
| Download tracking completeness | N/A (not deployed) | 100% of message-initiated downloads emit completion events | A missed completion event breaks the entire downstream pipeline |
| Message processing success rate | N/A | 99.5%+ | Failed messages mean lost download requests |
| Progress broadcast coverage | N/A | Every active download represented in every poll cycle | Gaps in progress data reduce trust in the system |
| Service uptime | N/A | 99%+ | Downtime means missed download commands and silent progress gaps |

---

## Anti-Goals

**We are explicitly NOT:**

1. **Searching for or discovering torrents**
   - Why not: This service only adds magnets it receives via messages. Torrent discovery is a completely separate concern that belongs upstream of the `downloads.add` queue.

2. **Managing downloaded media files**
   - Why not: No renaming, organizing, moving, or post-processing of completed files. That's Sonarr/Radarr territory. This service's responsibility ends at detecting completion and publishing the event.

3. **Exposing HTTP endpoints**
   - Why not: All communication is through RabbitMQ. Adding a REST API would create a parallel interface, bypassing the message broker that the entire platform depends on.

4. **Providing a web UI or dashboard**
   - Why not: qBittorrent already has a Web UI. Progress data is published as events for other services (like a notification consumer) to present however they choose.

**Feature requests to auto-reject:**
- Torrent search or discovery capabilities
- File renaming, moving, or media library integration
- REST/HTTP API endpoints
- Web dashboard or progress visualization UI
- Direct user interaction (this is a headless service)

---

## Constraints

| Constraint | Impact on Decisions |
|------------|---------------------|
| Polling-based design | qBittorrent has no webhooks or event push. Progress must be polled on a timer interval, creating an inherent delay between state changes and event emission. Interval is configurable but always a trade-off between freshness and API load. |
| Solo developer | Service must be simple, well-tested, and independently deployable. Complexity budget is limited — prefer straightforward patterns over clever abstractions. |
| Docker on QNAP NAS | Must run as a lightweight container. Limited compute means efficient polling and minimal memory footprint matter. |
| RabbitMQ as sole communication channel | No HTTP APIs, no direct service-to-service calls. Everything flows through message queues. |
| qBittorrent Web API surface | Limited to what qBittorrent's API exposes. Cannot access libtorrent internals or file system directly. API capabilities define the ceiling of what this service can report. |

---

## Feature Evaluation Checklist

Use this checklist when evaluating any proposed feature:

- [ ] **Target User:** Does this serve the solo dev / self-hoster persona?
- [ ] **Problem:** Does this help bridge qBittorrent into the event-driven ecosystem?
- [ ] **Differentiator:** Does this strengthen the event bridge pattern or lifecycle tracking?
- [ ] **Metrics:** Will this improve tracking completeness, processing success, or uptime?
- [ ] **Anti-goals:** Is this explicitly something we said we WON'T do?
- [ ] **Constraints:** Can this work within polling-based design, RabbitMQ-only communication, and qBittorrent API limits?

**Scoring:**
- 6/6 checks: Strong candidate
- 4-5/6 checks: Discuss trade-offs
- <4/6 checks: Likely reject or defer

---

## Changelog

| Date | Change | Reason |
|------|--------|--------|
| 2026-01-26 | Created canvas | Initial strategy definition for qBittorrent Consumer service |
| 2026-01-26 | Added downloads.removed event, category enum, polling failure alerting, exchange-to-exchange bindings | Architecture decisions from gap analysis |
