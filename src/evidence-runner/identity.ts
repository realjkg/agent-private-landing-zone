import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

import { identityVariables } from "../tools/identity.js";
import type { IdentityObservation, IdentityProbe } from "./preflight.js";
import type { Provider } from "./types.js";

/**
 * The read-only stages' identity check, in this process, before any read (delegated decision 2, #39 6433391052, applied in
 * its most restrictive form; docs/evidence-runner.md, "Identities").
 *
 * The runner verifies the federated DISCOVERY identity the producer will run under, from that identity's own identifiers:
 * the AWS role ARN's account and region, the Azure tenant and subscription, the GCP project and region. It reads variable
 * values that are identifiers, and checks with `lstat` that each token or credential-configuration file is a private regular
 * file of this user. It never opens a token, never calls a cloud, never starts a CLI, and never uses the operator's own CLI
 * login: that login is not needed and so is not touched (the open owner question A/B/C on #39 is answered here with the most
 * restrictive option; nothing in this runner reads it).
 *
 * What this proves: the identity the producer will present names the expected account, tenant or project, so its reads
 * cannot land elsewhere. What it does not prove: that the cloud accepts the token. Only the producer's own exchange shows
 * that, and its document is the evidence.
 */
type Requirement = { variable: string; kind: "value" | "file" };
const REQUIRED: Readonly<Record<Provider, readonly Requirement[]>> = {
  aws: [{ variable: "AWS_ROLE_ARN", kind: "value" }, { variable: "AWS_WEB_IDENTITY_TOKEN_FILE", kind: "file" }],
  azure: [
    { variable: "ARM_TENANT_ID", kind: "value" }, { variable: "ARM_SUBSCRIPTION_ID", kind: "value" }, { variable: "ARM_CLIENT_ID", kind: "value" },
    { variable: "ARM_OIDC_TOKEN_FILE", kind: "file" },
  ],
  gcp: [{ variable: "GOOGLE_PROJECT", kind: "value" }, { variable: "GOOGLE_APPLICATION_CREDENTIALS", kind: "file" }],
};
/** The unprefixed federated marker the Azure provider producer checks (src/qualification/identity.ts): a token file path. */
const AZURE_MARKER = "AZURE_FEDERATED_TOKEN_FILE";

const ROLE_ARN = /^arn:aws(?:-[a-z]+)*:iam::(\d{12}):role\/[A-Za-z0-9+=,.@_\/-]{1,512}$/;

/** Why `path` is not a private regular file of this user, or undefined. Uses `lstat` only: the file is never opened. */
export function privateFileProblem(path: string, uid: number | undefined): string | undefined {
  if (!isAbsolute(path)) return "is not an absolute path";
  let stat;
  try { stat = lstatSync(path); } catch { return "does not exist"; }
  if (stat.isSymbolicLink()) return "is a symbolic link";
  if (!stat.isFile()) return "is not a regular file";
  if (uid !== undefined && stat.uid !== uid) return "is not owned by the user running this command";
  if ((stat.mode & 0o077) !== 0) return "is readable or writable by group or others (mode 0" + (stat.mode & 0o777).toString(8) + ")";
  return undefined;
}

/** The federated DISCOVERY identity's identifiers, compared by `compareIdentity` in the preflight. Never a token. */
export function federatedProbe(env: NodeJS.ProcessEnv, uid: number | undefined = process.getuid?.()): IdentityProbe {
  return async (provider: Provider): Promise<IdentityObservation> => {
    const variables = identityVariables(env, "DISCOVERY");
    const missing = REQUIRED[provider].filter((need) => !variables.has(need.variable)).map((need) => "ALZ_DISCOVERY_" + need.variable);
    if (provider === "azure" && !env[AZURE_MARKER]) missing.push(AZURE_MARKER);
    if (missing.length > 0) {
      return { status: "MISSING", detail: "Set " + missing.join(", ") + " for the federated DISCOVERY identity (D4 delivery). The runner never substitutes your own CLI login." };
    }
    const files = [...REQUIRED[provider].filter((need) => need.kind === "file").map((need) => ["ALZ_DISCOVERY_" + need.variable, variables.get(need.variable)!] as const),
      ...(provider === "azure" ? [[AZURE_MARKER, env[AZURE_MARKER]!] as const] : [])];
    const problems = files.map(([name, path]) => [name, privateFileProblem(path, uid)] as const).filter(([, problem]) => problem !== undefined);
    if (problems.length > 0) return { status: "MISSING", detail: problems.map(([name, problem]) => name + " " + problem).join("; ") + ". It must name a private token file (mode 0600) of this user." };
    if (provider === "aws") {
      const match = ROLE_ARN.exec(variables.get("AWS_ROLE_ARN")!);
      if (!match) return { status: "MISSING", detail: "ALZ_DISCOVERY_AWS_ROLE_ARN is not an IAM role ARN." };
      const region = variables.get("AWS_REGION");
      return { status: "OBSERVED", kind: "FEDERATED", accountId: match[1], ...(region ? { region } : {}) };
    }
    if (provider === "azure") {
      return { status: "OBSERVED", kind: "FEDERATED", tenantId: variables.get("ARM_TENANT_ID"), subscriptionId: variables.get("ARM_SUBSCRIPTION_ID") };
    }
    const region = variables.get("GOOGLE_REGION");
    return { status: "OBSERVED", kind: "FEDERATED", projectId: variables.get("GOOGLE_PROJECT"), ...(region ? { region } : {}) };
  };
}
