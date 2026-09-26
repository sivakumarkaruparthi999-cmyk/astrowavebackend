# ==============================================================================
# AstroWave Backend — Hardened Multi-Stage Production Dockerfile
# Security: Unprivileged user, minimal attack surface, multi-stage, zero secrets
# ==============================================================================

# Stage 1: Build & Compile
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies needed for compiling native modules if any
RUN apk add --no-cache python3 make g++

# Copy dependency manifests
COPY package*.json tsconfig.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy application source and migrations
COPY src ./src

# Build production artifacts (TypeScript -> dist)
RUN npm run build

# Remove development dependencies
RUN npm prune --production

# Stage 2: Minimal Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5001

# Create an unprivileged system user and group (UID/GID 1001)
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Create directory for uploads with appropriate permissions
RUN mkdir -p /app/uploads /app/dist && \
    chown -R appuser:appgroup /app

# Copy built application and production dependencies from builder stage
COPY --from=builder --chown=appuser:appgroup /app/package*.json ./
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist

# Switch to unprivileged non-root user
USER appuser

EXPOSE 5001

# Health check instruction
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5001/api/health || exit 1

# Start server
CMD ["node", "dist/server.js"]
