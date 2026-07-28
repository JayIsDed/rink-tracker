# Rink Tracker — Bun + SQLite, no build step
FROM oven/bun:1.3-alpine

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production

COPY server ./server
COPY public ./public
# scripts/ ships with the image so the carry (V1, and the V7 re-carry at the
# flip) runs against the same code the container runs, not a copy on a laptop.
COPY scripts ./scripts

# The service worker keys its cache on the build sha. The image has no .git, so
# `git rev-parse` cannot run in here — the sha comes in as a build arg or the
# key silently falls back to "dev" and never busts. (footgun 2)
ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA

RUN mkdir -p /app/data /app/data/photos /app/data/photos/thumbs

ENV PORT=3737
ENV NODE_ENV=production

EXPOSE 3737

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e 'fetch("http://localhost:3737/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

CMD ["bun", "server/server.ts"]
