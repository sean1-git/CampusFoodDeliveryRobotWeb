# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
# Only web build inputs belong here, so backend or documentation changes can
# reuse the compiled frontend. Original artwork is needed only to create icons.
COPY index.html tsconfig*.json vite.config.ts capacitor.config.ts ./
COPY src ./src
COPY shared ./shared
COPY public ./public
COPY assets/app-logo.png ./assets/app-logo.png
COPY scripts/build-icons.mjs scripts/build-pwa.mjs scripts/build-compressed.mjs ./scripts/
RUN npm run build:web

# Stage 2: Runtime
FROM node:22-alpine

WORKDIR /app

# Browser dependencies are bundled into dist/client. The Node API uses only
# built-in modules and local files, so runtime does not need node_modules.
COPY --from=builder /app/dist/client ./dist/client
COPY server ./server
COPY --from=builder /app/shared ./shared
COPY drizzle/*.sql ./drizzle/
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "server/local.mjs"]
