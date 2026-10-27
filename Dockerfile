FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages packages
COPY services services
RUN bun install --frozen-lockfile --production --ignore-scripts
ARG SERVICE
RUN test -n "$SERVICE" && bun build "services/${SERVICE}/src/index.ts" --target bun --outdir /out --sourcemap=linked

FROM oven/bun:1.4.4-distroless
WORKDIR /app
COPY --from=build /out ./
USER 65532:65532
EXPOSE 3000
ENTRYPOINT ["bun", "index.js"]
