# Stage 1: build
FROM node:22-alpine AS builder

# Install build tools needed for better-sqlite3 native addon
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

RUN npm run build

# Stage 2: production image
FROM node:22-alpine AS production

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./

# Install build tools, compile native addons, then remove build tools.
#
# npm is deleted afterwards. The entrypoint is node, not npm, so nothing at
# runtime needs it -- but the copy bundled in node:22-alpine ships its own
# vendored dependencies (sigstore, pacote, brace-expansion, picomatch,
# ip-address), and those were the entire content of the Trivy scan failure.
# They are not reachable from our package.json, so no override or audit fix
# could clear them; removing the package manager from a production image is
# both the fix and the right thing independently.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/bin/npm /usr/local/bin/npx \
              /root/.npm

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Create non-root user and data directory
RUN addgroup -S sorokeep && adduser -S sorokeep -G sorokeep \
    && mkdir -p /home/sorokeep/.sorokeep \
    && chown -R sorokeep:sorokeep /home/sorokeep /app

USER sorokeep

# Persist SQLite database across container restarts
VOLUME ["/home/sorokeep/.sorokeep"]

ENTRYPOINT ["node", "/app/dist/index.js"]
