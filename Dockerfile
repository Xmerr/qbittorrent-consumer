# Stage 1: Build
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy consumer-shared first for dependency resolution
COPY consumer-shared/ ./consumer-shared/

# Copy service package files
COPY qbittorrent-consumer/package.json qbittorrent-consumer/bun.lock* ./qbittorrent-consumer/

# Install dependencies
WORKDIR /app/qbittorrent-consumer
RUN bun install --frozen-lockfile || bun install

# Copy source code
COPY qbittorrent-consumer/tsconfig.json ./
COPY qbittorrent-consumer/src/ ./src/

# Build TypeScript
RUN bun run build

# Stage 2: Production
FROM oven/bun:1 AS production

WORKDIR /app

# Create non-root user
RUN addgroup --gid 1001 --system nodejs && \
    adduser --system --uid 1001 nodejs

# Copy consumer-shared (needed at runtime for file: dependency)
COPY consumer-shared/ ./consumer-shared/

# Copy package files and install production deps
COPY qbittorrent-consumer/package.json ./qbittorrent-consumer/
WORKDIR /app/qbittorrent-consumer
RUN bun install --production

# Copy built artifacts
COPY --from=builder /app/qbittorrent-consumer/dist ./dist

ENV NODE_ENV=production

USER nodejs

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD bun -e "process.exit(0)"

CMD ["bun", "run", "dist/index.js"]
