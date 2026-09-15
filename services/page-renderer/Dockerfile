FROM mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS build

WORKDIR /repo/services/page-renderer
COPY services/page-renderer/package.json services/page-renderer/package-lock.json ./
RUN npm ci
COPY services/page-renderer/ ./
COPY packages/page-scene/ /repo/packages/page-scene/
RUN npm run build

FROM mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e

RUN apt-get update && apt-get install -y --no-install-recommends fonts-comic-neue \
    && echo "2728ee8f303e31934e62bf27b044fd7657b0613412d51f7444db1078cc3a7cb2  /usr/share/fonts/opentype/comic-neue/ComicNeue-Regular.otf" | sha256sum -c - \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/page-renderer/package.json services/page-renderer/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /repo/services/page-renderer/src ./src
COPY --from=build /repo/services/page-renderer/dist ./dist
COPY services/page-renderer/fonts.json services/page-renderer/entrypoint.sh ./
RUN chmod 0555 entrypoint.sh && useradd --uid 10001 --create-home renderer
USER renderer
ENV PORT=8090 \
    PAGE_RENDERER_CONFIG=/app/fonts.json
EXPOSE 8090
ENTRYPOINT ["/app/entrypoint.sh"]
