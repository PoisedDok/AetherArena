FROM node:24.5.0-slim AS builder

RUN apt-get update && apt-get install -y python3 python3-pip sqlite3 && rm -rf /var/lib/apt/lists/*

WORKDIR /home/perplexica

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000

# Pre-download ONNX embedding models into a deterministic cache path.
# We do this BEFORE copying src/ so that Docker caches the downloaded models
# and doesn't re-download them on every code change.
ENV HF_HOME=/home/perplexica/model-cache
COPY scripts/preload-embedding-models.mjs ./scripts/preload-embedding-models.mjs
RUN node scripts/preload-embedding-models.mjs \
    && echo "--- Model cache contents ---" \
    && find /home/perplexica/model-cache -type f | head -30

COPY tsconfig.json next.config.mjs next-env.d.ts postcss.config.js drizzle.config.ts tailwind.config.ts ./
COPY src ./src
COPY public ./public
COPY drizzle ./drizzle

RUN mkdir -p /home/perplexica/data

# Suppress stale browserslist / baseline-browser-mapping warnings at build time.
# These are data packages that expire every few months; pinning in yarn.lock is
# insufficient because the databases embed expiry dates.
RUN npx update-browserslist-db@latest --update-db 2>/dev/null || true \
    && yarn add baseline-browser-mapping@latest --dev 2>/dev/null || true

RUN yarn build

FROM node:24.5.0-slim

RUN apt-get update && apt-get install -y curl sudo && rm -rf /var/lib/apt/lists/*

WORKDIR /home/perplexica

# Copy standalone build from builder
COPY --from=builder /home/perplexica/public ./public
COPY --from=builder /home/perplexica/.next/static ./public/_next/static
COPY --from=builder /home/perplexica/.next/standalone ./
COPY --from=builder /home/perplexica/data ./data
COPY drizzle ./drizzle

# Copy pre-downloaded ONNX embedding model cache from builder.
# Must use same HF_HOME at runtime so @huggingface/transformers finds the cache.
COPY --from=builder /home/perplexica/model-cache /home/perplexica/model-cache
ENV HF_HOME=/home/perplexica/model-cache

RUN mkdir /home/perplexica/uploads

WORKDIR /home/perplexica
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
RUN sed -i 's/\r$//' ./entrypoint.sh || true

EXPOSE 3000

ENV SEARXNG_API_URL=http://searxng:8080

CMD ["/home/perplexica/entrypoint.sh"]
