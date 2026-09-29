# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
# Only web build inputs belong here, so backend or documentation changes can
# reuse the compiled frontend. Original artwork is needed only to create icons.
COPY tsconfig*.json vite.config.ts capacitor.config.ts ./
COPY apps/web/index.html ./apps/web/index.html
COPY apps/web/src ./apps/web/src
COPY packages/domain/src ./packages/domain/src
COPY apps/web/public ./apps/web/public
COPY apps/web/assets/app-logo.png ./apps/web/assets/app-logo.png
COPY tooling/build/build-icons.mjs tooling/build/build-pwa.mjs tooling/build/build-compressed.mjs ./tooling/build/
RUN npm run build:web

# Stage 2: Runtime
FROM node:22-alpine

WORKDIR /app

# Browser dependencies are bundled into dist/client. The Node API uses only
# built-in modules and local files, so runtime does not need node_modules.
COPY --from=builder /app/dist/client ./dist/client
COPY apps/api/src ./apps/api/src
COPY --from=builder /app/packages/domain/src ./packages/domain/src
COPY packages/database/migrations/*.sql ./packages/database/migrations/
COPY --from=builder /app/package.json ./

# Only the demo database directory is writable by the runtime process. Source,
# migrations, and bundled assets stay root-owned and readable by the node user.
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "apps/api/src/local.mjs"]
