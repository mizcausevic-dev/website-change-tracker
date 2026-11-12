# syntax=docker/dockerfile:1
# Base image pinned by digest (node:24.22.3-bookworm-slim, multi-arch index; a Node security release) so rebuilds are reproducible.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency install hooks run at build time.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
# TRUST_PROXY is deliberately not set here: it is only safe behind a proxy that appends the client IP
# (set it in the Cloud Run service config). Anywhere else it would let clients pick their rate-limit bucket.
ENV NODE_ENV=production PORT=8080
# Package managers are not needed at runtime; removing them shrinks the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
USER node
EXPOSE 8080
# TypeScript runs directly through Node's built-in type stripping; there is no build step.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
