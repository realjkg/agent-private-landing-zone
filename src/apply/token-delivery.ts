import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import { MAX_TOKEN_FILE, checkCredentialConfiguration, readRegularFile, readTokenFile } from "../tools/gcp-credentials.js";
import { identityVariables, type ExecutionIdentity } from "../tools/identity.js";
import { TOKEN_FILE } from "./constants.js";
import type { ProviderId } from "./types.js";

/**
 * Identity delivery by the controlled self-hosted runner (option A, owner decision of 2026-10-28; design and threat analysis in
 * docs/act-pilot-identity-delivery.md). The workflow `.github/workflows/act-identity-delivery.yml` runs one job per identity of a
 * release path on the owner's runner. Each job mints its own GitHub OIDC token for its own protected environment, writes it to
 * `<root>/<path>/<IDENTITY>.jwt` (mode 0600 in a 0700 directory) with a metadata file `<IDENTITY>.json` beside it, re-mints it
 * before it expires, and deletes both when the delivery ends. The person at the terminal points the identity variables at those
 * files and runs the driver; the job never runs the engine and never holds a cloud credential.
 *
 * This module judges the delivered files the driver is about to consume: private, distinct, fresh, and minted for the exact
 * environment, audience and workflow of each identity. It decodes the token's claims WITHOUT verifying the signature, so it
 * proves nothing about trust: only the cloud's own token exchange does (the owner's live run). It refuses honest mistakes and
 * stale or swapped files; the same-uid operator who holds these files is inside the trust boundary (src/apply/identities.ts).
 * Token files that are not laid out this way are left to the provider checks, unchanged.
 * Messages name identities, files and claims, never a token.
 */

/** The issuer every delivered token must name: GitHub Actions. */
export const DELIVERY_ISSUER = "https://token.actions.githubusercontent.com";
/** The one workflow that delivers tokens, as the token's `workflow_ref` names it (after `<owner>/<repo>/`). */
export const DELIVERY_WORKFLOW = ".github/workflows/act-identity-delivery.yml";
/** The only ref and event a delivered token may come from. */
export const DELIVERY_REF = "refs/heads/main";
export const DELIVERY_EVENT = "workflow_dispatch";
/** Seconds of validity a token must still have when a step starts; a token closer to expiry is refused, never extended. */
export const MIN_REMAINING_SECONDS = 60;
/** Clock skew tolerated for `iat`, `nbf` and the heartbeat. */
export const SKEW_SECONDS = 60;
/** The audiences the committed bootstraps trust by default (bootstrap/aws `oidc_audience`, bootstrap/azure `oidc_audience`). */
export const AWS_AUDIENCE = "sts.amazonaws.com";
export const AZURE_AUDIENCE = "api://AzureADTokenExchange";

export type DeliveryPathId = "aws-terraform" | "aws-cdk" | "azure-terraform" | "azure-bicep" | "gcp-terraform" | "gcp-api";

/**
 * The six release paths and what each delivers. `scope` is the trust scope the environments are named for: one per set of cloud
 * principals, so a token for one path's role can never be minted from another path's environment. Both Azure paths share the
 * same four Entra applications (bootstrap/azure), so they share one scope; Bicep delivers only DISCOVERY and APPLY.
 * `audience` is undefined for GCP, where it is the workload identity pool provider named in each credential configuration.
 */
export const DELIVERY_PATHS: Readonly<Record<DeliveryPathId, {
  provider: ProviderId; engine: string; scope: string; identities: readonly ExecutionIdentity[]; audience?: string;
}>> = {
  "aws-terraform": { provider: "AWS", engine: "TERRAFORM", scope: "aws-terraform", identities: ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"], audience: AWS_AUDIENCE },
  "aws-cdk": { provider: "AWS", engine: "CDK", scope: "aws-cdk", identities: ["DISCOVERY", "CHANGESET", "APPLY"], audience: AWS_AUDIENCE },
  "azure-terraform": { provider: "AZURE", engine: "TERRAFORM", scope: "azure", identities: ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"], audience: AZURE_AUDIENCE },
  "azure-bicep": { provider: "AZURE", engine: "BICEP", scope: "azure", identities: ["DISCOVERY", "APPLY"], audience: AZURE_AUDIENCE },
  "gcp-terraform": { provider: "GCP", engine: "TERRAFORM", scope: "gcp-terraform", identities: ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"] },
  "gcp-api": { provider: "GCP", engine: "GCP_API", scope: "gcp-api", identities: ["DISCOVERY", "APPLY"] },
};

export const isDeliveryPath = (value: unknown): value is DeliveryPathId => typeof value === "string" && Object.hasOwn(DELIVERY_PATHS, value);

/** The delivery path of a provider and engine, or undefined. */
export function deliveryPathOf(provider: ProviderId, engine: string): DeliveryPathId | undefined {
  return (Object.keys(DELIVERY_PATHS) as DeliveryPathId[]).find((id) => DELIVERY_PATHS[id].provider === provider && DELIVERY_PATHS[id].engine === engine);
}

const SLUG: Readonly<Record<ExecutionIdentity, string>> = { DISCOVERY: "discovery", STATE: "state", STATE_WRITE: "state-write", APPLY: "apply", CHANGESET: "changeset" };

/** The protected GitHub environment that mints one identity's token: `act-dev-<scope>-<identity>`, lowercase. DEV only. */
export const deliveryEnvironment = (path: DeliveryPathId, identity: ExecutionIdentity): string => "act-dev-" + DELIVERY_PATHS[path].scope + "-" + SLUG[identity];

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const RUN_ID = /^[0-9]{1,20}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const META_BYTES = 64 * 1024;
const META_KEYS = ["schemaVersion", "kind", "path", "identity", "environment", "audience", "repository", "runId", "subject", "refreshedAt", "tokenExpiresAt", "holdUntil", "refreshSeconds"];

/** The metadata the delivery job writes beside each token, refreshed with it. It holds no token. */
export type DeliveryMetadata = {
  schemaVersion: 1; kind: "alz-identity-delivery"; path: DeliveryPathId; identity: ExecutionIdentity; environment: string; audience: string;
  repository: string; runId: string; subject: string; refreshedAt: string; tokenExpiresAt: string; holdUntil: string; refreshSeconds: number;
};

/** What a check records about one delivered identity. Never the token: a short fingerprint shows two identities' tokens differ. */
export type DeliveredIdentity = {
  identity: ExecutionIdentity; environment: string; issuer: string; subject: string; audience: string; repository: string; runId: string;
  issuedAt: string; expiresAt: string; secondsRemaining: number; refreshedAt: string; holdUntil: string;
  tokenFile: string; fileMode: string; directoryMode: string; tokenFingerprint: string;
};

export type DeliveryCheck =
  | { ok: true; delivered: false }
  | { ok: true; delivered: true; path: DeliveryPathId; sessionDir: string; identities: DeliveredIdentity[] }
  | { ok: false; code: "IDENTITY_NOT_CONFIGURED" | "IDENTITY_COLLAPSED"; message: string };

/** Where an identity's OIDC token file is, as the provider's variables name it, and the audience its credential configuration sets (GCP). */
export function tokenFileOf(env: NodeJS.ProcessEnv, provider: ProviderId, identity: ExecutionIdentity): { file?: string; configAudience?: string } {
  const variables = identityVariables(env, identity);
  if (provider === "AWS") return { file: variables.get("AWS_WEB_IDENTITY_TOKEN_FILE") };
  if (provider === "AZURE") return { file: variables.get("ARM_OIDC_TOKEN_FILE") };
  const config = variables.get("GOOGLE_APPLICATION_CREDENTIALS");
  if (config === undefined) return {};
  const result = checkCredentialConfiguration(config);
  return result.ok ? { file: result.tokenFile, configAudience: result.audience } : {};
}

/** The audience a delivered token for this path must carry: the bootstrap default, or for GCP `https:` + the pool provider name. */
export function expectedAudience(path: DeliveryPathId, configAudience: string | undefined): string | undefined {
  const fixed = DELIVERY_PATHS[path].audience;
  if (fixed !== undefined) return fixed;
  return configAudience === undefined ? undefined : "https:" + configAudience;
}

const octal = (mode: number): string => "0" + (mode & 0o777).toString(8);

function lstatOrUndefined(path: string): Stats | undefined {
  try { return lstatSync(path); } catch { return undefined; }
}

/** Why `path` is not a private regular file of this user (0600 or tighter, one link, no symlink), or undefined. */
export function privateFileProblem(path: string, uid: number): string | undefined {
  const stat = lstatOrUndefined(path);
  if (!stat) return "is missing";
  if (stat.isSymbolicLink()) return "is a symbolic link";
  if (!stat.isFile()) return "is not a regular file";
  if (stat.uid !== uid) return "is not owned by the user running this command";
  if ((stat.mode & 0o077) !== 0) return "is readable or writable by group or others (mode " + octal(stat.mode) + ")";
  if (stat.nlink !== 1) return "has another hard link";
  return undefined;
}

/** Why `path` is not a private directory of this user (0700 or tighter, no symlink, its real path), or undefined. */
export function privateDirectoryProblem(path: string, uid: number): string | undefined {
  const stat = lstatOrUndefined(path);
  if (!stat) return "is missing";
  if (stat.isSymbolicLink()) return "is a symbolic link";
  if (!stat.isDirectory()) return "is not a directory";
  if (stat.uid !== uid) return "is not owned by the user running this command";
  if ((stat.mode & 0o077) !== 0) return "is open to group or others (mode " + octal(stat.mode) + ")";
  try { if (realpathSync(path) !== path) return "is not its own real path (a parent is a symbolic link)"; } catch { return "cannot be resolved"; }
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The claims of a JWT, decoded without verifying anything. Undefined when it is not a JWT with a JSON object payload. */
export function decodeClaims(token: string): Record<string, unknown> | undefined {
  if (!JWT.test(token)) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return isRecord(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

function readMetadata(path: string): DeliveryMetadata | string {
  let parsed: unknown;
  try {
    const bytes = readRegularFile(path, META_BYTES);
    if (bytes === undefined) return "is not a regular file of at most 64 KiB";
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return "cannot be read as UTF-8 JSON";
  }
  if (!isRecord(parsed) || Object.keys(parsed).sort().join(",") !== [...META_KEYS].sort().join(",")) return "does not have exactly the delivery metadata fields";
  const m = parsed;
  const isTime = (value: unknown): boolean => typeof value === "string" && !Number.isNaN(Date.parse(value));
  if (m.schemaVersion !== 1 || m.kind !== "alz-identity-delivery" || !isDeliveryPath(m.path) || typeof m.identity !== "string" ||
    typeof m.environment !== "string" || typeof m.audience !== "string" || typeof m.repository !== "string" || !REPOSITORY.test(m.repository) ||
    typeof m.runId !== "string" || !RUN_ID.test(m.runId) || typeof m.subject !== "string" || !isTime(m.refreshedAt) || !isTime(m.tokenExpiresAt) ||
    !isTime(m.holdUntil) || typeof m.refreshSeconds !== "number" || !Number.isInteger(m.refreshSeconds) || m.refreshSeconds < 5 || m.refreshSeconds > 120) {
    return "is not a valid delivery metadata record";
  }
  return m as unknown as DeliveryMetadata;
}

const audienceOf = (aud: unknown): string | undefined =>
  typeof aud === "string" ? aud : Array.isArray(aud) && aud.length === 1 && typeof aud[0] === "string" ? aud[0] : undefined;

/** Why the claims are not exactly those of this identity's delivery job, or undefined. Nothing here verifies a signature. */
export function claimsProblem(
  claims: Record<string, unknown>, expected: { environment: string; audience: string; repository: string; runId: string }, now: Date,
): string | undefined {
  const seconds = now.getTime() / 1000;
  if (claims.iss !== DELIVERY_ISSUER) return "was not issued by GitHub Actions (iss)";
  if (audienceOf(claims.aud) !== expected.audience) return "does not carry exactly the audience " + expected.audience + " (aud)";
  const sub = claims.sub;
  if (typeof sub !== "string" || !sub.startsWith("repo:") || !sub.endsWith(":environment:" + expected.environment) || /[*?\s]/.test(sub)) {
    return "is not bound to the environment " + expected.environment + " (sub)";
  }
  if (claims.environment !== expected.environment) return "names another environment (environment)";
  if (claims.repository !== expected.repository) return "comes from another repository (repository)";
  if (claims.event_name !== DELIVERY_EVENT) return "was not minted by a workflow_dispatch run (event_name)";
  if (claims.ref !== DELIVERY_REF) return "was not minted from main (ref)";
  if (claims.workflow_ref !== expected.repository + "/" + DELIVERY_WORKFLOW + "@" + DELIVERY_REF) return "was not minted by the identity delivery workflow on main (workflow_ref)";
  if (claims.runner_environment !== "self-hosted") return "was not minted on a self-hosted runner (runner_environment)";
  if (String(claims.run_id) !== expected.runId) return "comes from another delivery run (run_id)";
  if (typeof claims.exp !== "number" || typeof claims.iat !== "number") return "has no expiry or issue time (exp, iat)";
  if (claims.exp - seconds < MIN_REMAINING_SECONDS) return "has expired or expires within " + MIN_REMAINING_SECONDS + " seconds (exp)";
  if (claims.iat > seconds + SKEW_SECONDS) return "was issued in the future (iat)";
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > seconds + SKEW_SECONDS)) return "is not valid yet (nbf)";
  return undefined;
}

/** True when `child` is `parent` or inside it. */
const within = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const refuse = (code: "IDENTITY_NOT_CONFIGURED" | "IDENTITY_COLLAPSED", message: string): DeliveryCheck => ({ ok: false, code, message });

export type DeliveryCheckInput = {
  env: NodeJS.ProcessEnv;
  path: DeliveryPathId;
  now: Date;
  /** The product checkout: a session directory inside it is refused. */
  repoRoot: string;
  /** Defaults to this process's uid. */
  uid?: number;
  /** For the owner's verification command: the repository the tokens must come from. The driver binds the files to each other instead. */
  repository?: string;
  /** The verification command judges the files even when none is marked delivered (so a missing delivery fails rather than passes). */
  requireDelivered?: boolean;
};

/**
 * Judges the token files of a path's identities. When none of them is laid out as a delivery (`<IDENTITY>.jwt` in `<root>/<path>`,
 * or beside its metadata), nothing is delivered and the result is `{ ok: true, delivered: false }` (unless `requireDelivered`). Otherwise every identity of the path must be delivered,
 * by one run, into one private session directory `<root>/<path>` outside the checkout, and each token must be private, distinct,
 * fresh, still refreshed by its job, and minted for exactly its own environment, audience, repository and the delivery workflow on main.
 */
export function checkDeliveredTokens(input: DeliveryCheckInput): DeliveryCheck {
  const { env, path, now } = input;
  const uid = input.uid ?? process.getuid?.() ?? -1;
  const spec = DELIVERY_PATHS[path];
  const located = spec.identities.map((identity) => ({ identity, ...tokenFileOf(env, spec.provider, identity) }));
  const metaOf = (file: string, identity: ExecutionIdentity): string => join(dirname(file), identity + ".json");
  // Delivered: named <IDENTITY>.jwt, and either in a directory named for the path or beside its metadata. A delivered layout whose
  // files are gone (released, cleaned or never written) is judged, and refused, rather than passed to the provider as a plain path.
  const marked = located.filter(({ identity, file }) =>
    file !== undefined && basename(file) === identity + ".jwt" && (basename(dirname(file)) === path || lstatOrUndefined(metaOf(file, identity)) !== undefined));
  if (marked.length === 0 && !input.requireDelivered) return { ok: true, delivered: false };
  const unmarked = located.filter((entry) => !marked.includes(entry)).map(({ identity }) => identity);
  if (unmarked.length > 0) {
    return refuse("IDENTITY_NOT_CONFIGURED", "These identities' token files are not delivered files <root>/" + path + "/<IDENTITY>.jwt with their metadata beside them: " +
      unmarked.join(", ") + ". Every identity of a path is delivered by one run, or none is.");
  }

  const files = located.map(({ file }) => file!);
  const problems: string[] = [];
  for (const file of files) if (!TOKEN_FILE.test(file)) problems.push(file + " is not an absolute path of plain characters");
  if (problems.length > 0) return refuse("IDENTITY_NOT_CONFIGURED", problems.join("; ") + ".");
  const sessionDir = dirname(files[0]);
  if (files.some((file) => dirname(file) !== sessionDir)) {
    return refuse("IDENTITY_NOT_CONFIGURED", "The delivered token files are not all in one session directory. Each run delivers every identity of the path into <root>/" + path + ".");
  }
  if (basename(sessionDir) !== path) return refuse("IDENTITY_NOT_CONFIGURED", "The session directory " + sessionDir + " is not named for the path " + path + ".");
  if (within(input.repoRoot, sessionDir)) return refuse("IDENTITY_NOT_CONFIGURED", "The session directory " + sessionDir + " is inside the product checkout. Token files never live under the repository.");
  for (const dir of [dirname(sessionDir), sessionDir]) {
    const problem = privateDirectoryProblem(dir, uid);
    if (problem) return refuse("IDENTITY_NOT_CONFIGURED", "The delivery directory " + dir + " " + problem + ".");
  }

  const delivered: DeliveredIdentity[] = [];
  const tokens: string[] = [];
  for (const { identity, file, configAudience } of located) {
    const name = "the " + identity + " token";
    const metaFile = metaOf(file!, identity);
    const fileProblem = privateFileProblem(file!, uid) ?? privateFileProblem(metaFile, uid);
    if (fileProblem) { problems.push(name + " or its metadata " + fileProblem); continue; }
    const meta = readMetadata(metaFile);
    if (typeof meta === "string") { problems.push(identity + "'s delivery metadata " + meta); continue; }
    const environment = deliveryEnvironment(path, identity);
    const audience = expectedAudience(path, configAudience);
    if (audience === undefined) { problems.push(name + "'s credential configuration names no workload identity audience"); continue; }
    if (meta.path !== path || meta.identity !== identity || meta.environment !== environment || meta.audience !== audience) {
      problems.push(name + "'s metadata is for another path, identity, environment or audience"); continue;
    }
    if (input.repository !== undefined && meta.repository !== input.repository) { problems.push(name + " was delivered for another repository"); continue; }
    const refreshed = Date.parse(meta.refreshedAt);
    if (now.getTime() - refreshed > (2 * meta.refreshSeconds + SKEW_SECONDS) * 1000 || refreshed > now.getTime() + SKEW_SECONDS * 1000) {
      problems.push(name + " is stale: its delivery job stopped refreshing it (re-run the delivery; an old token is never extended)"); continue;
    }
    if (Date.parse(meta.holdUntil) <= now.getTime()) { problems.push(name + "'s delivery window has ended"); continue; }
    const token = readTokenFile(file!);
    const claims = token === undefined || token.length > MAX_TOKEN_FILE ? undefined : decodeClaims(token);
    if (token === undefined || claims === undefined) { problems.push(name + " is not a JWT"); continue; }
    const claimProblem = claimsProblem(claims, { environment, audience, repository: meta.repository, runId: meta.runId }, now);
    if (claimProblem) { problems.push(name + " " + claimProblem); continue; }
    if (claims.sub !== meta.subject) { problems.push(name + "'s subject differs from its metadata"); continue; }
    tokens.push(token);
    const exp = claims.exp as number;
    delivered.push({
      identity, environment, issuer: DELIVERY_ISSUER, subject: claims.sub as string, audience, repository: meta.repository, runId: meta.runId,
      issuedAt: new Date((claims.iat as number) * 1000).toISOString(), expiresAt: new Date(exp * 1000).toISOString(),
      secondsRemaining: Math.floor(exp - now.getTime() / 1000), refreshedAt: meta.refreshedAt, holdUntil: meta.holdUntil, tokenFile: file!,
      fileMode: octal(lstatSync(file!).mode), directoryMode: octal(lstatSync(sessionDir).mode),
      tokenFingerprint: createHash("sha256").update(token).digest("hex").slice(0, 16),
    });
  }
  if (problems.length > 0) return refuse("IDENTITY_NOT_CONFIGURED", "The delivered identity tokens are refused: " + problems.join("; ") + ".");

  // One run, one repository, one subject prefix; and no two identities holding the same token, subject or token id.
  if (new Set(delivered.map((d) => d.runId)).size !== 1 || new Set(delivered.map((d) => d.repository)).size !== 1) {
    return refuse("IDENTITY_NOT_CONFIGURED", "The delivered tokens come from more than one delivery run or repository. Deliver every identity of the path in one run.");
  }
  if (new Set(delivered.map((d) => d.subject.slice(0, d.subject.lastIndexOf(":environment:")))).size !== 1) {
    return refuse("IDENTITY_NOT_CONFIGURED", "The delivered tokens' subjects name more than one repository.");
  }
  const jtis = tokens.map((token) => decodeClaims(token)!.jti).filter((jti) => jti !== undefined).map(String);
  if (new Set(tokens).size !== tokens.length || new Set(delivered.map((d) => d.subject)).size !== delivered.length || new Set(jtis).size !== jtis.length) {
    return refuse("IDENTITY_COLLAPSED", "Two identities hold the same token, subject or token id. Each identity must be a separate principal with its own token.");
  }
  return { ok: true, delivered: true, path, sessionDir, identities: delivered };
}

/** What a session directory still holds after cleanup: the names of every entry, or an empty list when it is gone or empty. */
export function sessionLeftovers(sessionDir: string): string[] {
  try { return readdirSync(sessionDir).sort(); } catch { return []; }
}

/**
 * The owner's verification record (`./alz apply identity-check`), written on the MBP. It says what the files on this host show
 * and, as plainly, what they cannot show. HOST_LOCAL: it is never LIVE provider evidence and never passes a release gate.
 */
export type IdentityDeliveryEvidence = {
  schemaVersion: 1;
  kind: "act-identity-delivery-check";
  label: "HOST_LOCAL";
  phase: "delivered" | "cleaned";
  path: DeliveryPathId;
  provider: ProviderId;
  engine: string;
  repository: string;
  checkedAt: string;
  result: "PASS" | "FAIL";
  failures: string[];
  identities: DeliveredIdentity[];
  /** Cleaned phase: each identity's token and metadata files, and whether each is gone. */
  removed: { identity: ExecutionIdentity; tokenFile?: string; tokenGone: boolean; metadataGone: boolean }[];
  /** Cleaned phase: every entry the session directory still holds (names only). */
  leftovers: string[];
  /** Whether the provider's own identity check (role ARNs, client ids, no fallback) also passes; reported, not part of `result`. */
  driverIdentityConfiguration: { ready: boolean; detail?: string };
  proves: string[];
  doesNotProve: string[];
};

const DOES_NOT_PROVE = [
  "that any cloud trusts these tokens: the signature is not verified here, and no token is exchanged; only the owner's live run (STS, Entra ID or Google STS sign-ins, with CloudTrail or sign-in log corroboration) proves trust",
  "that the GitHub settings are in place (required reviewer, main-only deployment branches, fork approval, the subject claim template); the owner checks them against the checklist",
  "that the runner's job-started hook is installed and refuses other workflows; the owner proves that with the negative dispatch in the checklist",
  "anything about QA or PROD: delivery is DEV only",
];

/**
 * Builds the record for one phase. `delivered`: every identity of the path is delivered by one run and passes every check the
 * driver makes, with the repository named. `cleaned`: every token and metadata file is gone and the session directory is gone or empty.
 */
export function identityDeliveryEvidence(input: {
  env: NodeJS.ProcessEnv; path: DeliveryPathId; repository: string; phase: "delivered" | "cleaned"; now: Date; repoRoot: string; uid?: number;
  driverIdentityConfiguration: { ready: boolean; detail?: string };
}): IdentityDeliveryEvidence {
  const spec = DELIVERY_PATHS[input.path];
  const failures: string[] = [];
  let identities: DeliveredIdentity[] = [];
  const removed: IdentityDeliveryEvidence["removed"] = [];
  let leftovers: string[] = [];
  let proves: string[] = [];
  if (!REPOSITORY.test(input.repository)) failures.push("--repository is not OWNER/REPO");
  else if (input.phase === "delivered") {
    const check = checkDeliveredTokens({ env: input.env, path: input.path, now: input.now, repoRoot: input.repoRoot, uid: input.uid, repository: input.repository, requireDelivered: true });
    if (!check.ok) failures.push(check.message);
    else if (check.delivered) {
      identities = check.identities;
      proves = [
        "each identity of the path has its own token file, private to this user (mode " + [...new Set(identities.map((d) => d.fileMode))].join(", ") +
          ") in a private session directory outside the checkout",
        "each token was minted for its own environment (" + identities.map((d) => d.environment).join(", ") + "), with distinct subjects and token fingerprints",
        "each token carries the exact audience its cloud's bootstrap trusts, and names GitHub Actions as issuer, this repository, workflow_dispatch from main, the delivery workflow and a self-hosted runner (claims read without signature verification)",
        "each token was fresh when checked (" + identities.map((d) => d.identity + " " + d.secondsRemaining + " s left").join(", ") + ") and its delivery job was still refreshing it",
      ];
    }
  } else {
    let sessionDir: string | undefined;
    for (const identity of spec.identities) {
      const { file } = tokenFileOf(input.env, spec.provider, identity);
      if (file === undefined) { removed.push({ identity, tokenGone: false, metadataGone: false }); failures.push(identity + "'s token file is not named by its identity variables, so its removal cannot be checked"); continue; }
      sessionDir ??= dirname(file);
      const tokenGone = lstatOrUndefined(file) === undefined;
      const metadataGone = lstatOrUndefined(join(dirname(file), identity + ".json")) === undefined;
      removed.push({ identity, tokenFile: file, tokenGone, metadataGone });
      if (!tokenGone || !metadataGone) failures.push(identity + "'s token or metadata file is still present");
    }
    leftovers = sessionDir === undefined ? [] : sessionLeftovers(sessionDir);
    if (leftovers.length > 0) failures.push("the session directory still holds " + leftovers.length + " entr" + (leftovers.length === 1 ? "y" : "ies"));
    if (failures.length === 0) proves = ["every token and metadata file of the path is gone, and the session directory is gone or empty"];
  }
  return {
    schemaVersion: 1, kind: "act-identity-delivery-check", label: "HOST_LOCAL", phase: input.phase, path: input.path, provider: spec.provider, engine: spec.engine,
    repository: input.repository, checkedAt: input.now.toISOString(), result: failures.length === 0 ? "PASS" : "FAIL", failures, identities, removed, leftovers,
    driverIdentityConfiguration: input.driverIdentityConfiguration, proves, doesNotProve: DOES_NOT_PROVE,
  };
}
