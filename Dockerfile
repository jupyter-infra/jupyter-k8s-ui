# Build the frontend and backend together using Bun
FROM oven/bun:1 AS builder
WORKDIR /app

# Copy package files first for better layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source code (node_modules excluded via .dockerignore)
COPY . .

# Build frontend
RUN bun run build:full

# Final image - use Bun runtime for the TypeScript backend
FROM oven/bun:1-slim
WORKDIR /app

# Copy built application with correct ownership in one step (avoids slow recursive chown)
COPY --from=builder --chown=1000:1000 /app/dist ./dist
COPY --from=builder --chown=1000:1000 /app/server ./server
COPY --from=builder --chown=1000:1000 /app/package.json /app/bun.lock ./

# Install production dependencies only (skip lifecycle scripts — husky is dev-only)
RUN bun install --production --frozen-lockfile --ignore-scripts

USER 1000:1000

EXPOSE 8090

CMD ["bun", "run", "start"]
