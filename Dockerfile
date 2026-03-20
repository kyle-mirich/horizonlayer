FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY config.example.yaml ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/config.example.yaml ./config.example.yaml
RUN mkdir -p /app/runtime-state/cache /app/runtime-state/hf \
  && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 CMD node -e "fetch(`http://localhost:${process.env.PORT ?? '3000'}/healthz`).then((res) => { if (!res.ok) process.exit(1); }).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
