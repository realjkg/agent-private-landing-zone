import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getLocalModelMetadata, type LocalModelMetadata } from "../ollama.js";

/**
 * The exact model versions of the release (config/tool-pins.json, `isolatedOllama`).
 *
 * A tag such as `mistral-nemo:latest` names whatever the registry serves today, so a tag alone is not a version. Each
 * release model is pinned by its Ollama manifest digest: the sha256 of the manifest, which is the Docker-Content-Digest
 * registry.ollama.ai returns for `/v2/library/<name>/manifests/<tag>` and the `digest` that `ollama list` and /api/tags
 * report for the installed copy. `./alz models verify` and the console's readiness check compare the installed digest
 * with the committed one and refuse a model whose pin is missing (null, an owner input still open) or different.
 *
 * Nothing here downloads, pulls or contacts a registry: the comparison reads the local inventory only.
 */
export const MODEL_PINS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "tool-pins.json");

export type ModelDigestPins = {
  /** The release models, in pin-file order. */
  models: readonly string[];
  /** Each release model's manifest digest as 64 lowercase hex characters, or null while the owner has not recorded it. */
  digests: ReadonlyMap<string, string | null>;
};

export type DigestRefusalCode = "MODEL_DIGEST_UNPINNED" | "MODEL_DIGEST_MISMATCH" | "MODEL_DIGEST_INVALID";
export type DigestCheck =
  | { ok: true; model: string; digest: string }
  | { ok: false; model: string; code: DigestRefusalCode; message: string; observed?: string; pinned?: string | null };

const HEX64 = /^[0-9a-f]{64}$/;
/** An exact model tag: a library name and an explicit tag that is not `latest`. */
const EXACT_TAG = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/;

/** `sha256:<hex>` or `<hex>`, lowercased; undefined when it is not a sha256 digest. */
export function normalizeDigest(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.trim().toLowerCase().replace(/^sha256:/, "");
  return HEX64.test(hex) ? hex : undefined;
}

/** True for a tag that names one version: an explicit tag that is not `latest`. */
export function isExactModelTag(model: string): boolean {
  return EXACT_TAG.test(model) && !model.endsWith(":latest");
}

/** Reads and checks the release pins. A malformed file throws, so nothing is checked against a half-valid list. */
export function loadModelDigestPins(path: string = MODEL_PINS_PATH): ModelDigestPins {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { isolatedOllama?: { models?: unknown; modelDigests?: unknown } };
  const models = raw.isolatedOllama?.models;
  const digests = raw.isolatedOllama?.modelDigests;
  if (!Array.isArray(models) || models.length === 0 || !models.every((model) => typeof model === "string" && isExactModelTag(model))) {
    throw new Error("MODEL_PINS_INVALID: every release model is an exact tag (never :latest)");
  }
  if (typeof digests !== "object" || digests === null || Array.isArray(digests)) throw new Error("MODEL_PINS_INVALID: modelDigests is missing");
  const entries = Object.entries(digests as Record<string, unknown>);
  if (entries.map(([model]) => model).sort().join() !== [...models].sort().join()) {
    throw new Error("MODEL_PINS_INVALID: modelDigests must name exactly the release models");
  }
  const map = new Map<string, string | null>();
  for (const [model, value] of entries) {
    if (value === null) { map.set(model, null); continue; }
    if (typeof value !== "string" || !HEX64.test(value)) throw new Error("MODEL_PINS_INVALID: " + model + " digest is not 64 lowercase hex characters");
    map.set(model, value);
  }
  return { models: [...models] as string[], digests: map };
}

/** Compares an installed model's digest with its committed pin. A missing pin or digest is a refusal, never a pass. */
export function checkModelDigest(model: string, observedDigest: unknown, pins: ModelDigestPins): DigestCheck {
  if (!pins.digests.has(model)) {
    return { ok: false, model, code: "MODEL_DIGEST_UNPINNED", message: model + " is not a release model in config/tool-pins.json, so no digest pins it.", pinned: null };
  }
  const pinned = pins.digests.get(model) ?? null;
  if (pinned === null) {
    return { ok: false, model, code: "MODEL_DIGEST_UNPINNED", pinned,
      message: model + " has no committed digest yet (owner input). Record the registry's Docker-Content-Digest in config/tool-pins.json modelDigests in a reviewed commit." };
  }
  const observed = normalizeDigest(observedDigest);
  if (!observed) {
    return { ok: false, model, code: "MODEL_DIGEST_INVALID", pinned, message: "The local inventory reported no sha256 digest for " + model + "." };
  }
  if (observed !== pinned) {
    return { ok: false, model, code: "MODEL_DIGEST_MISMATCH", observed, pinned,
      message: model + " is installed with digest " + observed.slice(0, 12) + "…, but the release pins " + pinned.slice(0, 12) + "…. Pull the pinned version, or change the pin in a reviewed commit." };
  }
  return { ok: true, model, digest: observed };
}

/** Reads one model's installed metadata from the local (loopback-only) server and checks it against its pin. */
export async function verifyPinnedModel(baseUrl: string, model: string, pins: ModelDigestPins):
  Promise<{ metadata: LocalModelMetadata; check: DigestCheck }> {
  const metadata = await getLocalModelMetadata(baseUrl, model);
  return { metadata, check: checkModelDigest(model, metadata.digest, pins) };
}
