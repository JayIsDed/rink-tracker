# Rink Tracker — Bun + SQLite, no build step
FROM oven/bun:1.3-alpine

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production

COPY server ./server
COPY public ./public

RUN mkdir -p /app/data /app/data/photos /app/data/photos/thumbs

ENV PORT=3737
ENV NODE_ENV=production

EXPOSE 3737

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e 'fetch("http://localhost:3737/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

CMD ["bun", "server/server.ts"]
