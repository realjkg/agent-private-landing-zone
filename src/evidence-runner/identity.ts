import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { identityVariables } from "../tools/identity.js";
import type { IdentityObservation, IdentityProbe } from "./preflight.js";
import type { Provider } from "./types.js";

/**
 * The read-only stages' identity check, in this process, before any read (delegated decision 2, #39 6433391052, applied in
 * its most restrictive form; docs/evidence-runner.md, "Identities").
 *
 * The runner verifies what the producer's tools will actually sign in with, never the operator's own CLI login:
 *
 *  - AWS: the `aws` CLI as DISCOVERY takes its identity from `ALZ_DISCOVERY_AWS_ROLE_ARN` with a web identity token file. The
 *    role ARN names the account (and `ALZ_DISCOVERY_AWS_REGION` the region). A profile, config file or shared-credentials
 *    file under any identity would outrank or replace that web identity in the CLI's credential chain, so it refuses the
 *    stage (review B1 on #349).
 *  - Azure: `az` as DISCOVERY signs in only from `ALZ_DISCOVERY_AZURE_CONFIG_DIR`; it ignores `ARM_*`. That folder must be a
 *    private (0700) folder of this user, its own real path, outside the real home and the checkout, so it can never be the
 *    operator's `~/.azure`. Its `azureProfile.json` (subscriptions, tenant and the signed-in principal's type; it holds no
 *    token, which az keeps in `msal_token_cache.*`) names the default subscription and tenant az will use, and the principal
 *    must be a service principal (the federated identity signed in with `az login --service-principal --federated-token`),
 *    never a user. The runner does not create or sign in to that folder itself: that would mean reading the delivered token
 *    and handing it to `az` as an argument.
 *  - GCP: the project and region of the DISCOVERY identity's variables.
 *
 * Each token or credential-configuration file is checked with `lstat` only and never opened. Nothing here calls a cloud or
 * starts a CLI. After the producer ran, the read-only stage compares the account the producer itself observed with the
 * configuration again (readonly.ts), so a document produced elsewhere is never taken as evidence.
 */
type Requirement = { variable: string; kind: "value" | "file" };
const REQUIRED: Readonly<Record<Provider, readonly Requirement[]>> = {
  aws: [{ variable: "AWS_ROLE_ARN", kind: "value" }, { variable: "AWS_WEB_IDENTITY_TOKEN_FILE", kind: "file" }],
  azure: [{ variable: "AZURE_CONFIG_DIR", kind: "value" }],
  gcp: [{ variable: "GOOGLE_PROJECT", kind: "value" }, { variable: "GOOGLE_APPLICATION_CREDENTIALS", kind: "file" }],
};
/** The unprefixed federated marker the Azure provider producer checks (src/qualification/identity.ts): a token file path. */
const AZURE_MARKER = "AZURE_FEDERATED_TOKEN_FILE";

/** AWS variables that would replace or outrank the verified web identity in the CLI's credential chain (any identity prefix). */
const AWS_CHAIN_OVERRIDE = /^ALZ_[A-Z_]+_AWS_(PROFILE|DEFAULT_PROFILE|CONFIG_FILE|SHARED_CREDENTIALS_FILE)$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

const within = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
};

/** Why `path` cannot be az's DISCOVERY configuration folder, or undefined. `lstat` and `realpath` only. */
export function azureConfigDirProblem(path: string, options: { uid?: number; realHome?: string; root?: string }): string | undefined {
  if (!isAbsolute(path)) return "is not an absolute path";
  let stat;
  try { stat = lstatSync(path); } catch { return "does not exist"; }
  if (stat.isSymbolicLink()) return "is a symbolic link";
  if (!stat.isDirectory()) return "is not a folder";
  if (options.uid !== undefined && stat.uid !== options.uid) return "is not owned by the user running this command";
  if ((stat.mode & 0o077) !== 0) return "is open to group or others (mode 0" + (stat.mode & 0o777).toString(8) + "; it must be 0700)";
  let real: string;
  try { real = realpathSync(path); } catch { return "cannot be resolved"; }
  if (real !== path.replace(/\/+$/, "")) return "is not its own real path (a parent is a symbolic link)";
  for (const [name, base] of [["your home folder", options.realHome], ["this checkout", options.root]] as const) {
    if (!base) continue;
    let baseReal = base;
    try { baseReal = realpathSync(base); } catch { /* compare as given */ }
    if (within(baseReal, real)) return "is inside " + name + "; it must be a dedicated folder elsewhere, never your own ~/.azure";
  }
  const link = linkInside(real);
  if (link) return "holds " + link + " (review N7 on #349): a link could point az at another folder's sign-in, such as your own ~/.azure";
  return undefined;
}

/**
 * The first symbolic link (or an entry that cannot be read) anywhere inside `dir`, as a path relative to it, or undefined. az
 * reads its sign-in from several files in the folder (azureProfile.json, msal_token_cache.*, service_principal_entries.*,
 * clouds.config and more), so every entry is checked with `lstat`, down to a bounded depth and count. Nothing is opened. A
 * folder too large or too deep to check is refused, never assumed clean.
 */
function linkInside(dir: string, depth = 0, budget = { entries: 5000 }): string | undefined {
  let names: string[];
  try { names = readdirSync(dir); } catch { return "an unreadable folder"; }
  for (const name of names) {
    if ((budget.entries -= 1) < 0) return "more entries than the runner checks (5000)";
    const path = join(dir, name);
    let stat;
    try { stat = lstatSync(path); } catch { return name + " (unreadable)"; }
    if (stat.isSymbolicLink()) return "a symbolic link, " + name;
    if (stat.isDirectory()) {
      if (depth >= 6) return "folders nested deeper than the runner checks, under " + name;
      const inner = linkInside(path, depth + 1, budget);
      if (inner) return inner.startsWith("a symbolic link, ") ? "a symbolic link, " + name + "/" + inner.slice("a symbolic link, ".length) : inner;
    }
  }
  return undefined;
}

/**
 * The default subscription az will use from `<dir>/azureProfile.json`: its id, its tenant and the signed-in principal's type.
 * That file lists subscriptions and holds no token. Anything unreadable or ambiguous is refused, never guessed.
 */
export function azureDefaultAccount(dir: string): { ok: true; tenantId: string; subscriptionId: string; principalType: string; principalName: string } | { ok: false; detail: string } {
  const file = join(dir, "azureProfile.json");
  let text: string;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return { ok: false, detail: "azureProfile.json in ALZ_DISCOVERY_AZURE_CONFIG_DIR is not a plain file; sign the federated identity in there first" };
    text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch { return { ok: false, detail: "ALZ_DISCOVERY_AZURE_CONFIG_DIR has no azureProfile.json; sign the federated DISCOVERY identity in there first" }; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, detail: "azureProfile.json in ALZ_DISCOVERY_AZURE_CONFIG_DIR is not JSON" }; }
  const subscriptions = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { subscriptions?: unknown }).subscriptions) ? (parsed as { subscriptions: unknown[] }).subscriptions : [];
  // az decides the default by Python truthiness, so anything but a real boolean could make the runner and az disagree (review N8).
  if (subscriptions.some((item) => typeof item !== "object" || item === null || typeof (item as Record<string, unknown>).isDefault !== "boolean")) {
    return { ok: false, detail: "azureProfile.json in ALZ_DISCOVERY_AZURE_CONFIG_DIR has a subscription whose isDefault is not true or false" };
  }
  const defaults = subscriptions.filter((item): item is Record<string, unknown> => (item as Record<string, unknown>).isDefault === true);
  if (defaults.length !== 1) return { ok: false, detail: "azureProfile.json in ALZ_DISCOVERY_AZURE_CONFIG_DIR names " + defaults.length + " default subscriptions; exactly one is needed" };
  const chosen = defaults[0];
  const subscriptionId = typeof chosen.id === "string" ? chosen.id.toLowerCase() : "";
  const tenantId = typeof chosen.tenantId === "string" ? chosen.tenantId.toLowerCase() : "";
  const user = typeof chosen.user === "object" && chosen.user !== null ? chosen.user as Record<string, unknown> : {};
  const principalType = typeof user.type === "string" ? user.type : "";
  // For a service principal, az records its application (client) id as the user name.
  const principalName = typeof user.name === "string" ? user.name.toLowerCase() : "";
  if (!GUID.test(subscriptionId) || !GUID.test(tenantId)) return { ok: false, detail: "the default subscription in azureProfile.json has no well-formed id or tenant" };
  return { ok: true, tenantId, subscriptionId, principalType, principalName };
}

export type ProbeOptions = { uid?: number; realHome?: string; root?: string };

/** The federated DISCOVERY identity's identifiers, compared by `compareIdentity` in the preflight. Never a token. */
export function federatedProbe(env: NodeJS.ProcessEnv, options: ProbeOptions = {}): IdentityProbe {
  const uid = "uid" in options ? options.uid : process.getuid?.();
  const realHome = options.realHome ?? homedir();
  return async (provider: Provider): Promise<IdentityObservation> => {
    const variables = identityVariables(env, "DISCOVERY");
    if (provider === "aws") {
      const overrides = Object.keys(env).filter((name) => AWS_CHAIN_OVERRIDE.test(name) && env[name]).sort();
      if (overrides.length > 0) {
        return { status: "REFUSED", detail: "Unset " + overrides.join(", ") + ": a profile, config file or shared-credentials file would outrank or replace the verified web identity in the aws CLI's credential chain." };
      }
    }
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
      const dir = variables.get("AZURE_CONFIG_DIR")!;
      const problem = azureConfigDirProblem(dir, { uid, realHome, root: options.root });
      if (problem) return { status: "REFUSED", detail: "ALZ_DISCOVERY_AZURE_CONFIG_DIR " + problem + "." };
      const account = azureDefaultAccount(dir);
      if (!account.ok) return { status: "MISSING", detail: account.detail + "." };
      if (account.principalType !== "servicePrincipal") {
        return { status: "REFUSED", detail: "ALZ_DISCOVERY_AZURE_CONFIG_DIR is signed in as a " + (account.principalType || "principal of unknown type") + ", not the federated service principal; the runner never uses a person's own login." };
      }
      // A consistency check, not proof (review N9): the folder's own profile names the client id; only the token's appid claim,
      // which the runner never reads, would prove which principal signed in.
      const clientId = variables.get("ARM_CLIENT_ID")?.toLowerCase();
      if (clientId !== undefined && account.principalName !== clientId) {
        return { status: "REFUSED", detail: "ALZ_DISCOVERY_AZURE_CONFIG_DIR is signed in as client " + (account.principalName || "unknown") + ", not ALZ_DISCOVERY_ARM_CLIENT_ID " + clientId + " (a consistency check of the folder's own profile)." };
      }
      return { status: "OBSERVED", kind: "FEDERATED", tenantId: account.tenantId, subscriptionId: account.subscriptionId };
    }
    const region = variables.get("GOOGLE_REGION");
    return { status: "OBSERVED", kind: "FEDERATED", projectId: variables.get("GOOGLE_PROJECT"), ...(region ? { region } : {}) };
  };
}
