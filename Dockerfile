# ---------- Base builder: install deps and compile TypeScript ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Toolchain for native deps during build
RUN apk add --no-cache python3 make g++ git

# Install deps (prod+dev) and build
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build


# ---------- Runtime image (root) ----------
FROM node:20-alpine AS runner
WORKDIR /app

# TLS trust + curl for healthchecks
RUN apk add --no-cache ca-certificates curl && update-ca-certificates

# Copy manifests and install only PRODUCTION deps (includes local CLI)
COPY package.json package-lock.json* ./
ENV PATH="/app/node_modules/.bin:${PATH}"
RUN npm ci --omit=dev
RUN npm install -g @anthropic-ai/claude-code@2.0.8 \
 && ln -sf /usr/local/bin/claude /usr/bin/claude

# Copy compiled JS
COPY --from=builder /app/dist ./dist

# Root user + stable HOME
USER root
ENV HOME=/root
ENV PORT=8080

# Clean workspace to avoid CLI scans/prompts
RUN mkdir -p /workspace

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/ >/dev/null || exit 1

EXPOSE 8080
CMD ["node", "dist/server.js"]
