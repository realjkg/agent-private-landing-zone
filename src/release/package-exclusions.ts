import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The field package exclusion guard (owner decision 2026-10-29, "Close ACT enablement blockers", item 4; docs/field-package.md).
 *
 * The release archive and the runtime image are a supervised DEV ACT pilot package. They must never carry what makes a host
 * able to act on a customer target, or what a pilot run leaves behind: an enabled or owner contract, tokens, private keys,
 * runner registration secrets, Terraform state and saved plans, `.runs/` evidence and sealed plans, delivered identities, or
 * service units that would install an unattended runner. This module decides that from the package's own bytes.
 *
 * It fails closed. A path or a content match is a finding; a file it cannot read, a symbolic link or any other non-regular
 * entry is a finding too, because a tar archive would carry it while the release manifest (regular files only) would not.
 * Nothing here removes, rewrites or redacts anything: a finding stops the build, and a person removes the file.
 */
export const EXCLUSION_CODES = [
  "PILOT_CONTRACT", "ENABLED_CONTRACT", "OWNER_CONFIGURATION", "TOKEN", "PRIVATE_KEY", "CLOUD_CREDENTIALS",
  "RUNNER_REGISTRATION", "SERVICE_UNIT", "TERRAFORM_STATE", "TERRAFORM_WORKDIR", "TERRAFORM_VARIABLES", "SAVED_PLAN",
  "RUN_EVIDENCE", "PILOT_EVIDENCE", "SEALED_PLAN", "SIGNED_APPROVAL", "DELIVERED_IDENTITY", "NOT_A_REGULAR_FILE", "UNREADABLE",
] as const;
export type ExclusionCode = typeof EXCLUSION_CODES[number];
export type ExclusionFinding = { path: string; code: ExclusionCode; reason: string };

/** What the guard refuses, one line per code, in the words docs/field-package.md and field-package.json use. */
export const EXCLUSION_RULES: Readonly<Record<ExclusionCode, string>> = {
  PILOT_CONTRACT: "the owner's pilot contract (config/act-pilot-contract.json) or its retired pin, enabled or not",
  ENABLED_CONTRACT: "any contract-shaped JSON that is enabled or carries an authorize entry",
  OWNER_CONFIGURATION: "the owner's own runner configuration (config/evidence-runner.json), which names customer targets",
  TOKEN: "token files and token values: JWTs, GitHub tokens, AWS access key ids, .env, .npmrc and .netrc files",
  PRIVATE_KEY: "private keys: PEM, OpenSSH, PKCS#8/PKCS#12, Java keystores, PuTTY and id_* key files",
  CLOUD_CREDENTIALS: "cloud CLI credential folders (.aws, .azure, gcloud)",
  RUNNER_REGISTRATION: "self-hosted runner registration files (.runner, .credentials*, .service, svc.sh, actions-runner/)",
  SERVICE_UNIT: "service definitions that would run something unattended (launchd .plist, systemd .service/.timer/.socket units)",
  TERRAFORM_STATE: "Terraform state (*.tfstate*, terraform.tfstate.d/, lock info)",
  TERRAFORM_WORKDIR: "Terraform working folders (.terraform/)",
  TERRAFORM_VARIABLES: "Terraform variable files with real values (*.tfvars, *.tfvars.json; the .example files are allowed)",
  SAVED_PLAN: "saved plans (*.tfplan, tfplan, plan.out, *.plan)",
  RUN_EVIDENCE: "anything under .runs/ (evidence, sealed plans, ledgers, journals, qualification records)",
  PILOT_EVIDENCE: "pilot evidence and proposals outside .runs/ (*.evidence, *.cleanup-proposal.json, *.removal-proposal.json, consumed-nonces.jsonl)",
  SEALED_PLAN: "a sealed pilot plan, by its content",
  SIGNED_APPROVAL: "a signed pilot approval, by its content",
  DELIVERED_IDENTITY: "delivered identity files and the runner hook installation (.alz-identity/, .alz-runner-hook/)",
  NOT_A_REGULAR_FILE: "symbolic links and other non-regular entries, which the release manifest cannot check",
  UNREADABLE: "a file the guard cannot read, which it therefore cannot clear",
};

const finding = (path: string, code: ExclusionCode, detail?: string): ExclusionFinding =>
  ({ path, code, reason: detail ?? EXCLUSION_RULES[code] });

const lower = (value: string) => value.toLowerCase();
const RUNNER_FILES = new Set([".runner", ".runner_migrated", ".credentials", ".credentials_rsaparams", ".credentials_migrated", ".service", "svc.sh"]);
const KEY_FILES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk"]);
const TOKEN_FILES = new Set([".npmrc", ".netrc", "_netrc", ".git-credentials", "token"]);

/**
 * The findings for one package-relative path (POSIX separators), from its name alone. Pure: `verify` applies it to the
 * file list a release manifest names, and the build applies it to every entry it walks.
 */
export function pathExclusions(path: string): ExclusionFinding[] {
  const out: ExclusionFinding[] = [];
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  const names = segments.map(lower);
  const base = names[names.length - 1] ?? "";
  const dirs = names.slice(0, -1);
  const add = (code: ExclusionCode) => { if (!out.some((x) => x.code === code)) out.push(finding(path, code)); };
  const normalized = names.join("/");

  if (normalized === "config/act-pilot-contract.json" || normalized === "config/act-pilot-contract.sha256" || base === "act-pilot-contract.json") add("PILOT_CONTRACT");
  if (normalized === "config/evidence-runner.json") add("OWNER_CONFIGURATION");
  if (names.includes(".runs")) add("RUN_EVIDENCE");
  if (names.includes(".alz-identity") || names.includes(".alz-runner-hook")) add("DELIVERED_IDENTITY");
  if (dirs.includes(".terraform") || base === ".terraform") add("TERRAFORM_WORKDIR");
  if (/\.tfstate(\.|$)/.test(base) || names.includes("terraform.tfstate.d") || base === ".terraform.tfstate.lock.info") add("TERRAFORM_STATE");
  if (base.endsWith(".tfplan") || base === "tfplan" || base === "plan.out" || base.endsWith(".plan")) add("SAVED_PLAN");
  if (base.endsWith(".tfvars") || base.endsWith(".tfvars.json")) add("TERRAFORM_VARIABLES");
  if (base.endsWith(".evidence") || base.endsWith(".cleanup-proposal.json") || base.endsWith(".removal-proposal.json") || base === "consumed-nonces.jsonl") add("PILOT_EVIDENCE");
  if (RUNNER_FILES.has(base) || base.startsWith(".credentials") || names.includes("actions-runner")) add("RUNNER_REGISTRATION");
  if (/\.(plist|service|timer|socket)$/.test(base) || names.includes("launchagents") || names.includes("launchdaemons")) add("SERVICE_UNIT");
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk)$/.test(base) || KEY_FILES.has(base)) add("PRIVATE_KEY");
  if (/\.(jwt|token)$/.test(base) || TOKEN_FILES.has(base) || base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) add("TOKEN");
  if (dirs.includes(".aws") || dirs.includes(".azure") || dirs.includes("gcloud")) add("CLOUD_CREDENTIALS");
  return out;
}

/** A PEM private key with a body (base64 or an encrypted header), also inside a JSON string; never a pattern that only names one. */
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\r?\n|\\(?:r\\)?n)(?:Proc-Type:|[A-Za-z0-9+/]{40})/;
const PUTTY_KEY = /PuTTY-User-Key-File-\d+:/;
/** A signed JWT: two base64url JSON segments (`eyJ` is `{"`) and a signature. */
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const has = (value: Record<string, unknown>, ...keys: string[]) => keys.every((key) => Object.hasOwn(value, key));

/** The findings for one file's bytes. JSON is also judged by shape: an enabled contract, a sealed plan or a signed approval. */
export function contentExclusions(path: string, bytes: Buffer): ExclusionFinding[] {
  const out: ExclusionFinding[] = [];
  const text = bytes.toString("latin1");
  if (PEM_PRIVATE_KEY.test(text) || PUTTY_KEY.test(text)) out.push(finding(path, "PRIVATE_KEY", "the file holds a private key"));
  if (JWT.test(text)) out.push(finding(path, "TOKEN", "the file holds a JWT"));
  else if (GITHUB_TOKEN.test(text)) out.push(finding(path, "TOKEN", "the file holds a GitHub token"));
  else if (AWS_ACCESS_KEY_ID.test(text)) out.push(finding(path, "TOKEN", "the file holds an AWS access key id"));
  if (lower(path).endsWith(".json")) {
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { value = undefined; }
    if (isRecord(value)) {
      if (has(value, "provider", "engine", "targets", "approvers", "killSwitchPath")) {
        const authorize = value.authorize;
        const authorizes = authorize !== undefined && !(isRecord(authorize) && Object.keys(authorize).length === 0);
        if (value.enabled !== false || authorizes) out.push(finding(path, "ENABLED_CONTRACT", "a pilot contract that is enabled or carries an authorize entry"));
      }
      if (has(value, "artifactSha256", "planSha256", "manifestHash")) out.push(finding(path, "SEALED_PLAN"));
      const statement = isRecord(value.statement) ? value.statement : value;
      if (has(statement, "artifactSha256", "approverId", "nonce")) out.push(finding(path, "SIGNED_APPROVAL"));
    }
  }
  return out;
}

/**
 * Every finding under a package root. The root-level `node_modules` (installed dependencies, which the release manifest also
 * leaves out and the SBOM and audit cover) is the one folder not walked. Sorted, so the result is the same on every host.
 */
export async function scanPackageRoot(root: string): Promise<ExclusionFinding[]> {
  const out: ExclusionFinding[] = [];
  const walk = async (relative: string): Promise<void> => {
    let entries: string[];
    try { entries = (await readdir(join(root, relative))).sort(); } catch { out.push(finding(relative || ".", "UNREADABLE")); return; }
    for (const name of entries) {
      const path = relative === "" ? name : relative + "/" + name;
      if (relative === "" && name === "node_modules") continue;
      let info;
      try { info = await lstat(join(root, path)); } catch { out.push(finding(path, "UNREADABLE")); continue; }
      out.push(...pathExclusions(path));
      if (info.isDirectory()) { await walk(path); continue; }
      if (!info.isFile()) { out.push(finding(path, "NOT_A_REGULAR_FILE")); continue; }
      let bytes: Buffer;
      try { bytes = await readFile(join(root, path)); } catch { out.push(finding(path, "UNREADABLE")); continue; }
      out.push(...contentExclusions(path, bytes));
    }
  };
  await walk("");
  return out.sort((a, b) => a.path === b.path ? a.code.localeCompare(b.code) : a.path < b.path ? -1 : 1);
}

/** One line per finding, for an error message or a blocker list. */
export const describeFindings = (findings: readonly ExclusionFinding[]): string[] =>
  findings.map((x) => x.code + " " + x.path + ": " + x.reason);
