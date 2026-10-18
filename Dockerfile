FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
# The landing page is served from here at runtime, not bundled into dist.
COPY public/ ./public/

EXPOSE 8787

# node, not curl: the slim image has no curl, so the old check could never pass.
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run as the image's `node` user, numerically, so kubelet can verify
# runAsNonRoot without reading /etc/passwd. Everything the server reads under
# /app stays root-owned and world-readable; it writes nothing to disk, so it
# also runs on a read-only root filesystem (see
# https://docs.mctl.ai/guides/scaffolding#container-requirements).
USER 1000:1000

# node directly, not `npm run start`: npm as PID 1 does not forward SIGTERM to
# the server, and under a read-only root filesystem it cannot write its logs.
CMD ["node", "dist/index.js"]
