FROM oven/bun:1.3.11 AS dependencies

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.11

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER bun
EXPOSE 8080

CMD ["bun", "run", "src/http-server.ts"]
