# Rink Tracker — Bun + SQLite, no build step
FROM oven/bun:1.3-alpine

WORKDIR /app

COPY package.json tsconfig.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /app/data

ENV PORT=3737
ENV NODE_ENV=production

EXPOSE 3737

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e 'fetch("http://localhost:3737/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

CMD ["bun", "server/server.ts"]
