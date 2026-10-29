import type { EngineSpec } from "./engine-spec.js";

/**
 * The GCP API-native target shape (path 6; docs/act-pilot-gcp-api-driver.md D4 and D9, owner-accepted in 6483366237), shared so
 * the path's engine spec (lane G2) declares exactly this and nothing else. It is not registered as an engine here: a GCP_API
 * contract stays NOT_IMPLEMENTED until that lane lands (src/apply/contract.ts, PLANNED_PATHS).
 *
 * A DEV target names the provider's account fields (`projectId`, `region`), optionally `parent` (the GCP provider's optional
 * field, owner-declared and never observed by this path), and:
 * - `backend`: exactly the sentinel `GCP_API_NO_STATE`. The path keeps no state; upper case and underscores cannot occur in a topic
 *   id, a bucket or a prefix, so the sentinel can never be read as, or collide with, a real name. No code reads it as a location.
 * - `workspace`: exactly `default`.
 * - `topicPrefix`: the namespace the owner authorizes, `alz-` then 1 to 40 of `a-z 0-9 -`, ending in `-`. Each run's topic is the
 *   prefix plus a 12-character hex suffix drawn once at seal (D10), so its full id still matches the `alz-` topic rule.
 * Every one of these joins the target hash (`pilotTargetSha256`): `topicPrefix` as a location field, `parent` when stated.
 */
export const GCP_API_BACKEND_SENTINEL = "GCP_API_NO_STATE";
export const GCP_API_WORKSPACE = "default";
export const TOPIC_PREFIX = /^alz-[a-z0-9-]{1,40}-$/;
/** A run's full topic id: the `alz-` topic rule, which every prefix plus suffix meets. The one copy in src/apply; the engine imports it. */
export const TOPIC_ID = /^alz-[a-z0-9-]{1,59}[a-z0-9]$/;
/** How `parent` is shown wherever this path shows it (preview, evidence, reports): the path never reads Resource Manager (D9). */
export const PARENT_LABEL = "owner-declared, not observed";

export const GCP_API_TARGET: NonNullable<EngineSpec["target"]> = {
  backendOk: (value) => value === GCP_API_BACKEND_SENTINEL,
  workspaceOk: (value) => value === GCP_API_WORKSPACE,
  // DEV only: there is no second environment whose backend could repeat it.
  backendMayRepeat: true,
  fields: { topicPrefix: (value) => typeof value === "string" && TOPIC_PREFIX.test(value) },
  locationFields: ["topicPrefix"],
};
