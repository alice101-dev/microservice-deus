FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages packages
COPY services services
COPY web web
RUN bun install --frozen-lockfile --ignore-scripts
ARG APP_VERSION=dev
ARG APP_ENVIRONMENT=staging
RUN cd web && APP_VERSION=$APP_VERSION APP_ENVIRONMENT=$APP_ENVIRONMENT bunx vite build \
    && bun build server/index.ts --target bun --outdir /out --sourcemap=linked \
    && cp -r build /out/build

FROM oven/bun:1.4.4-distroless
WORKDIR /app
COPY --from=build /out ./
ENV STATIC_ROOT=/app/build
USER 65532:65532
EXPOSE 3000
ENTRYPOINT ["bun", "index.js"]
