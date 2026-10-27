FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages packages
COPY services services
RUN bun install --frozen-lockfile --production --ignore-scripts
ARG SERVICE
RUN test -n "$SERVICE" \
    && entries="services/${SERVICE}/src/index.ts" \
    && if [ -f "services/${SERVICE}/src/migrate.ts" ]; then entries="$entries services/${SERVICE}/src/migrate.ts"; fi \
    && bun build $entries --target bun --outdir /out --root "services/${SERVICE}/src" --sourcemap=linked \
    && mkdir -p /out/migrations \
    && if [ -d "services/${SERVICE}/migrations" ]; then cp services/${SERVICE}/migrations/*.sql /out/migrations/; fi

FROM oven/bun:1.4.4-distroless
WORKDIR /app
COPY --from=build /out ./
USER 65532:65532
EXPOSE 3000
ENTRYPOINT ["bun", "index.js"]
