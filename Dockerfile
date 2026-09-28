# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:web

# Stage 2: Runtime
FROM node:22-alpine

WORKDIR /app

# Browser dependencies are bundled into dist/client. The Node API uses only
# built-in modules and local files, so runtime does not need node_modules.
COPY --from=builder /app/dist/client ./dist/client
COPY --from=builder /app/server ./server
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/drizzle/*.sql ./drizzle/
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "server/local.mjs"]
