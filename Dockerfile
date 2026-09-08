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

HEALTHCHECK --interval=30s --timeout=3s \
  CMD curl -f http://127.0.0.1:8787/healthz || exit 1

CMD ["npm", "run", "start"]
