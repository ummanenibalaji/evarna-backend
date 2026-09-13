# One image, two processes:
#   API:           docker run <image>
#   Voice worker:  docker run <image> node dist/workers/voice.worker.js start
#
# Debian slim, not Alpine: onnxruntime-node (Silero VAD) and LiveKit's rtc
# bindings ship glibc binaries only.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# Exec form, so SIGTERM reaches node and the graceful shutdown runs.
CMD ["node", "dist/server.js"]
