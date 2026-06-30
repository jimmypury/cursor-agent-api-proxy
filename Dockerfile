# syntax=docker/dockerfile:1

FROM node:20-trixie-slim AS builder

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod --ignore-scripts

# slim 仍是 glibc，满足 cursor CLI 对 glibc 的要求；基于 Debian 13 (Trixie)
FROM node:20-trixie-slim AS runner

RUN groupadd --gid 1001 nodejs \
  && useradd --uid 1001 --gid nodejs --create-home --shell /bin/bash nodejs

# apt-get 需要 root；curl 仅用于拉取 cursor CLI
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

USER nodejs

RUN curl -fsS --retry 5 --retry-delay 10 --retry-all-errors https://cursor.com/install | bash

ENV NODE_ENV=production PATH="/home/nodejs/.local/bin:${PATH}"

WORKDIR /app

COPY --from=builder --chown=nodejs:nodejs /app/package.json /app/pnpm-lock.yaml ./
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4646)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/standalone.js", "run"]
