FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --cache /tmp/npm-cache
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 MONITOR_ENABLED=true DATABASE_PATH=/data/polywatch.sqlite
WORKDIR /app
RUN mkdir -p /data && chown node:node /app /data
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server ./server
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--use-env-proxy", "server/index.mjs"]
