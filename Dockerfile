# syntax=docker/dockerfile:1
# Base image pinned by digest (node:24.11.0-bookworm-slim, multi-arch index) so rebuilds are reproducible.
FROM node:24.11.0-bookworm-slim@sha256:76d0ed0ed93bed4f4376211e9d8fddac4d8b3fbdb54cc45955696001a3c91152 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no dependency install hooks run at build time.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.11.0-bookworm-slim@sha256:76d0ed0ed93bed4f4376211e9d8fddac4d8b3fbdb54cc45955696001a3c91152
ENV NODE_ENV=production PORT=8080 TRUST_PROXY=true
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
USER node
EXPOSE 8080
# TypeScript runs directly through Node's built-in type stripping; there is no build step.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
