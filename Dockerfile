# One image per game: Vite-built client is served by the game server (same origin, one port).
# Build: docker build -t rune-online . (or docker compose up --build)
FROM node:22-alpine AS build
RUN npm i -g pnpm@12.14.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY client/package.json client/
COPY server/package.json server/
RUN pnpm install --frozen-lockfile
COPY shared shared
COPY client client
RUN pnpm --filter client build

FROM node:22-alpine
RUN npm i -g pnpm@12.14.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY client/package.json client/
COPY server/package.json server/
RUN pnpm install --frozen-lockfile --prod --filter server
COPY shared shared
COPY server server
COPY --from=build /app/client/dist public
ENV NODE_ENV=production PUBLIC_DIR=/app/public PORT=2567
EXPOSE 2567
WORKDIR /app/server
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:2567/health || exit 1
CMD ["node", "src/index.ts"]
