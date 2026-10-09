FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run check && npm run build

FROM build AS test

COPY test/ ./test/
COPY config/ ./config/
COPY policy/ ./policy/
COPY alz ./alz

RUN chmod +x ./alz

CMD ["npm", "test"]

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

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

USER node

ENTRYPOINT ["node", "dist/cli/operator.js"]
CMD ["help"]
