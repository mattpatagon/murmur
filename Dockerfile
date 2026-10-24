FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS dependencies

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY scripts/build-distribution.ts ./scripts/build-distribution.ts
COPY scripts/lib/distribution-notices.ts scripts/lib/deterministic-order.ts ./scripts/lib/
COPY LICENSE ./LICENSE
ARG MURMUR_RELEASE_REVISION=0000000000000000000000000000000000000000
RUN MURMUR_RELEASE_REVISION="$MURMUR_RELEASE_REVISION" bun run scripts/build-distribution.ts

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV MURMUR_DISTRIBUTION_DIRECTORY=/app/dist/public

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/dist/public ./dist/public
COPY package.json ./
COPY src ./src

USER bun
EXPOSE 8080

CMD ["bun", "run", "src/http-server.ts"]
