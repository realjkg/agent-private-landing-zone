FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run check && npm run build

FROM build AS test

ARG SOURCE_COMMIT
ENV ALZ_SOURCE_COMMIT=$SOURCE_COMMIT

COPY test/ ./test/
COPY config/ ./config/
COPY policy/ ./policy/
COPY compose.yaml ./compose.yaml
COPY docs/ ./docs/
COPY alz ./alz
COPY .github/workflows/model-qualification.yml ./.github/workflows/model-qualification.yml

RUN chmod +x ./alz

CMD ["npm", "test"]

# Production native dependencies must use the same musl ABI as the final
# ARM64 runtime. Compiler and npm tooling stay outside the shipped image.
FROM node:24-alpine AS runtime-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ \
    && apk upgrade --no-cache
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk upgrade --no-cache && apk add --no-cache libstdc++
COPY package.json package-lock.json ./
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config/ ./config/
COPY policy/ ./policy/

ARG SOURCE_COMMIT

# Inventory production dependencies in CycloneDX format.
RUN npm sbom --package-lock-only --omit=dev --sbom-format=cyclonedx > sbom.cdx.json

# Generate and verify the installed release manifest.
RUN node dist/cli/release-package.js \
      --root /app \
      --version 0.1.0 \
      --source-commit "$SOURCE_COMMIT" \
    && chmod 644 release-manifest.json \
    && node dist/cli/release-package.js --root /app --verify

# Global npm dependencies belong to the build/install toolchain, not the
# runtime. Several Trivy findings on the previous image came exclusively
# from /usr/local/lib/node_modules/npm.
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm /usr/local/bin/npx /root/.npm \
    && node dist/cli/release-package.js --root /app --verify

USER node

ENTRYPOINT ["node", "dist/cli/operator.js"]
CMD ["help"]
