FROM ghcr.io/aquasecurity/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa AS scanner

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build

WORKDIR /app

COPY --chmod=644 package.json package-lock.json ./
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run check && npm run build

# Release builds inspect the locked dependency graph and deployment code.
# Scanner errors and HIGH/CRITICAL findings both prevent packaging.
FROM build AS scan
ENV TRIVY_DB_REPOSITORY=ghcr.io/aquasecurity/trivy-db:2 \
    TRIVY_CHECKS_BUNDLE_REPOSITORY=ghcr.io/aquasecurity/trivy-checks:1
COPY --from=scanner /usr/local/bin/trivy /usr/local/bin/trivy
COPY config/ ./config/
COPY Dockerfile compose.yaml ./
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export SSL_CERT_FILE=/run/secrets/npm_ca; fi; \
    trivy fs --scanners vuln,misconfig --severity HIGH,CRITICAL --exit-code 1 \
      --format json --output /app/security-scan.json /app

FROM build AS test

COPY test/ ./test/
COPY config/ ./config/
COPY policy/ ./policy/
COPY alz ./alz
COPY Dockerfile compose.yaml ./

RUN chmod +x ./alz

CMD ["npm", "test"]

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    NPM_CONFIG_CACHE=/tmp/alz-npm-cache \
    TRIVY_CACHE_DIR=/tmp/alz-trivy \
    TRIVY_DB_REPOSITORY=ghcr.io/aquasecurity/trivy-db:2 \
    TRIVY_CHECKS_BUNDLE_REPOSITORY=ghcr.io/aquasecurity/trivy-checks:1

COPY --chmod=644 package.json package-lock.json ./
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --omit=dev \
    && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=scanner /usr/local/bin/trivy /usr/local/bin/trivy
COPY --from=scan /app/security-scan.json ./security-scan.json
COPY config/ ./config/
RUN chmod -R a+rX /app/config

ARG SOURCE_COMMIT
LABEL org.opencontainers.image.source="https://github.com/realjkg/agent-private-landing-zone" \
      org.opencontainers.image.revision=$SOURCE_COMMIT

# Inventory the same locked production graph installed by npm ci. npm's
# physical-tree SBOM path reports omitted dev dependencies as missing.
RUN npm sbom --package-lock-only --omit=dev --sbom-format cyclonedx > sbom.cdx.json

# Generate and verify the installed release manifest.
RUN node dist/cli/release-package.js \
      --root /app \
      --version 0.1.0 \
      --source-commit "$SOURCE_COMMIT" \
    && chmod 644 release-manifest.json \
    && node dist/cli/release-package.js --root /app --verify

# Writable evidence state is separate from immutable release files and key storage.
RUN mkdir -p /app/.runs && chown node:node /app/.runs

USER node

# Confirm installed-artifact provenance and all deterministic security controls
# without shipping a development key or depending on Git in the runtime image.
RUN AGENTIC_EVIDENCE_KEY_FILE=/tmp/alz-build-evidence.key \
      node dist/cli/security.js \
    && rm /tmp/alz-build-evidence.key

ENTRYPOINT ["node", "dist/cli/operator.js"]
CMD ["help"]
