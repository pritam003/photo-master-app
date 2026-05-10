# Use Debian-based image so TensorFlow's glibc-linked native binaries work at runtime.
# Alpine (musl libc) is incompatible with pre-built @tensorflow/tfjs-node binaries.
FROM node:22 AS builder
WORKDIR /app

# Build tools for native modules (canvas: cairo/pango; tfjs-node: python/make/g++)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    libcairo2-dev libpango1.0-dev libgif-dev librsvg2-dev libpixman-1-dev \
  && rm -rf /var/lib/apt/lists/*

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY lib/db/package.json ./lib/db/
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/api-client-react/package.json ./lib/api-client-react/

RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts

# Build native modules in the workspace so they are available in /app/node_modules.
RUN pnpm rebuild canvas @tensorflow/tfjs-node

COPY artifacts/api-server ./artifacts/api-server
COPY lib ./lib

# Build the app (outputs to artifacts/api-server/dist)
RUN node artifacts/api-server/build.mjs

# Use pnpm deploy to create a self-contained folder with all resolved node_modules.
# --ignore-scripts prevents tfjs-node's install.js from running again (it would try
# to re-download libtensorflow from CDN, which is unreliable in CI).
RUN pnpm --filter @workspace/api-server deploy --prod --legacy --ignore-scripts /app/deploy

# Rebuild native modules in the deploy layout.
# canvas: needs to relink against system cairo/pango headers in this stage.
# @tensorflow/tfjs-node: the builder stage already compiled both libtensorflow and the
#   tfjs_binding.node. We explicitly copy deps/ into the deploy layout (since
#   --ignore-scripts means install.js did not run), then rebuild only canvas.
WORKDIR /app/deploy
# Copy pre-built libtensorflow deps from the builder workspace into the deploy layout.
RUN bash -c '\
  SRC=$(find /app/node_modules -name "tfjs-node" -maxdepth 10 -type d 2>/dev/null | head -1); \
  [ -n "$SRC" ] && [ -d "$SRC/deps" ] || exit 0; \
  for dst in $(find ./node_modules -name "tfjs-node" -maxdepth 10 -type d 2>/dev/null); do \
    [ -d "$dst/deps" ] || cp -r "$SRC/deps" "$dst/deps"; \
  done' || true
# Copy pre-compiled tfjs_binding.node from the builder workspace (ignore-scripts skipped it).
RUN bash -c '\
  SRC=$(find /app/node_modules -name "tfjs_binding.node" -maxdepth 15 2>/dev/null | head -1); \
  [ -n "$SRC" ] || exit 0; \
  NAPI=$(basename $(dirname "$SRC")); \
  for dst in $(find ./node_modules -name "tfjs-node" -maxdepth 10 -type d 2>/dev/null); do \
    mkdir -p "$dst/lib/$NAPI" && cp "$SRC" "$dst/lib/$NAPI/tfjs_binding.node"; \
  done' || true
# Rebuild only canvas (needs system cairo/pango headers).
RUN npm rebuild canvas 2>&1
WORKDIR /app

# ---- runtime ----
FROM node:22-slim
WORKDIR /app

# Runtime shared libraries required by canvas, tfjs-node, sharp, and ffmpeg (video thumbnails)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 libpango-1.0-0 libgif7 librsvg2-2 libpixman-1-0 libvips \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/deploy ./

# Entrypoint: runs index.mjs by default; set WORKER_MODE=true to run worker.mjs instead.
# This avoids passing --enable-source-maps as a CLI arg to az containerapp create
# (az CLI misinterprets any value starting with - as its own flag).
COPY artifacts/api-server/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000

CMD ["/app/docker-entrypoint.sh"]
