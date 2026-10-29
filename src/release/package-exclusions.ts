import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

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
  PILOT_CONTRACT: "the owner's pilot contract (config/act-pilot-contract.json), a draft of it or any other act-pilot-contract* file but the disabled *.example.json shapes, enabled or not",
  ENABLED_CONTRACT: "a pilot contract that is enabled or carries an authorize entry, under any name (JSON with a BOM, UTF-16 or wrapped, YAML, one gzip or base64 layer)",
  OWNER_CONFIGURATION: "the owner's own runner configuration (config/evidence-runner.json), which names customer targets",
  TOKEN: "token files and token values: JWTs, GitHub tokens, AWS access key ids and secret keys, Azure storage keys, connection strings and SAS URLs, .env, .npmrc and .netrc files",
  PRIVATE_KEY: "private keys: PEM, OpenSSH, PKCS#8/PKCS#12, Java keystores, PuTTY and id_* key files",
  CLOUD_CREDENTIALS: "cloud credentials: an AWS shared-credentials file under any name, a service-account key file, and the .aws, .azure and gcloud folders",
  RUNNER_REGISTRATION: "self-hosted runner registration files (.runner, .credentials*, .service, svc.sh, actions-runner/)",
  SERVICE_UNIT: "service definitions that would run something unattended (launchd .plist, systemd .service/.timer/.socket units)",
  TERRAFORM_STATE: "Terraform state, by name (*.tfstate*, terraform.tfstate.d/, lock info) or by content (terraform_version, lineage, serial)",
  TERRAFORM_WORKDIR: "Terraform working folders (.terraform/)",
  TERRAFORM_VARIABLES: "Terraform variable files with real values (*.tfvars, *.tfvars.json; the .example files are allowed)",
  SAVED_PLAN: "saved plans, by name (*.tfplan, *.tfplan.json, tfplan, plan.out, *.plan) or by content (a zip of plan entries, a JSON plan)",
  RUN_EVIDENCE: "anything under .runs/ (evidence, sealed plans, ledgers, journals, qualification records)",
  PILOT_EVIDENCE: "pilot evidence and proposals outside .runs/ (*.evidence, *.cleanup-proposal.json, *.removal-proposal.json, consumed-nonces.jsonl)",
  SEALED_PLAN: "a sealed pilot plan, by its content, under any name",
  SIGNED_APPROVAL: "a signed pilot approval, by its content, under any name",
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

  if (base.startsWith("act-pilot-contract") && !base.endsWith(".example.json")) add("PILOT_CONTRACT");
  if (normalized === "config/evidence-runner.json") add("OWNER_CONFIGURATION");
  if (names.includes(".runs")) add("RUN_EVIDENCE");
  if (names.includes(".alz-identity") || names.includes(".alz-runner-hook")) add("DELIVERED_IDENTITY");
  if (dirs.includes(".terraform") || base === ".terraform") add("TERRAFORM_WORKDIR");
  if (/\.tfstate(\.|$)/.test(base) || names.includes("terraform.tfstate.d") || base === ".terraform.tfstate.lock.info") add("TERRAFORM_STATE");
  if (base.endsWith(".tfplan") || base.endsWith(".tfplan.json") || base === "tfplan" || base === "plan.out" || base.endsWith(".plan")) add("SAVED_PLAN");
  if (base.endsWith(".tfvars") || base.endsWith(".tfvars.json")) add("TERRAFORM_VARIABLES");
  if (base.endsWith(".evidence") || base.endsWith(".cleanup-proposal.json") || base.endsWith(".removal-proposal.json") || base === "consumed-nonces.jsonl") add("PILOT_EVIDENCE");
  if (RUNNER_FILES.has(base) || base.startsWith(".credentials") || names.includes("actions-runner")) add("RUNNER_REGISTRATION");
  if (/\.(plist|service|timer|socket)$/.test(base) || names.includes("launchagents") || names.includes("launchdaemons")) add("SERVICE_UNIT");
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk)$/.test(base) || KEY_FILES.has(base)) add("PRIVATE_KEY");
  if (/\.(jwt|token)$/.test(base) || TOKEN_FILES.has(base) || base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) add("TOKEN");
  if (dirs.includes(".aws") || dirs.includes(".azure") || dirs.includes("gcloud")) add("CLOUD_CREDENTIALS");
  return out;
}

/** A PEM private key with a body (base64 or an encrypted header), also inside a JSON string (escaped once or twice); never a pattern that only names one. */
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\r?\n|\\{1,2}(?:r\\{1,2})?n)(?:Proc-Type:|[A-Za-z0-9+/]{40})/;
const PUTTY_KEY = /PuTTY-User-Key-File-\d+:/;
const KUBE_CLIENT_KEY = /client-key-data:\s*[A-Za-z0-9+/]{40}/;
/** A signed JWT: two base64url JSON segments (`eyJ` is `{"`) and a signature. Unanchored, so a token glued to a word is found. */
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/;
const GITHUB_TOKEN = /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/;
const AWS_ACCESS_KEY_ID = /(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/;
/** An AWS secret access key by its own key name (aws_secret_access_key, AWS_SECRET_KEY, SECRET_ACCESS_KEY, the STS SecretAccessKey field) and a 40-character value. */
const AWS_SECRET = /(?:aws_?secret_?(?:access_?)?key|secret_?access_?key)["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/i;
const INI_SECTION = /^\s*\[[^\]\r\n]+\]\s*$/m;
const AWS_INI_KEY = /^\s*aws_(?:access_key_id|secret_access_key|session_token)\s*=\s*\S/im;
const AZURE_ACCOUNT_KEY = /AccountKey=[A-Za-z0-9+/]{20,}={0,2}/;
const AZURE_SAS_STRING = /SharedAccessSignature=[^;\s"']*sig=/i;
const SAS_SIG = /[?&]sig=[A-Za-z0-9%+/=]{16,}/g;

/** An Azure SAS URL: a `sig=` signature with another SAS field (`sv=`, `se=`, `sp=` and the rest) or on an Azure storage host. */
function sasUrl(text: string): boolean {
  for (const match of text.matchAll(SAS_SIG)) {
    const at = match.index ?? 0;
    const from = Math.max(0, at - 2048);
    const query = text.slice(from, at + match[0].length + 2048);
    const local = at - from;
    const begin = query.slice(0, local).search(/[^\s"'<>]*$/);
    const finish = query.slice(local).search(/[\s"'<>]/);
    const url = query.slice(begin, finish < 0 ? undefined : local + finish);
    if (/[?&](?:sv|se|sp|sr|srt|ss|st|spr|skoid|sktid)=/.test(url) || /\.core\.windows\.net[/:?]/i.test(url)) return true;
  }
  return false;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const has = (value: Record<string, unknown>, ...keys: string[]) => keys.every((key) => Object.hasOwn(value, key));
const ENVIRONMENT_KEYS = new Set(["DEV", "QA", "PROD"]);
/** A contract's `authorize` entry: environments mapped to the operations ACT may run there. */
const authorizes = (value: unknown): boolean => isRecord(value) &&
  Object.entries(value).some(([key, ops]) => ENVIRONMENT_KEYS.has(key.toUpperCase()) &&
    (Array.isArray(ops) ? ops.length > 0 : typeof ops === "string" || (isRecord(ops) && Object.keys(ops).length > 0)));

/** What one parsed JSON value is, by shape, at any depth up to four (so a wrapper array or object does not hide it). */
function shapeFindings(path: string, root: unknown): ExclusionFinding[] {
  const out: ExclusionFinding[] = [];
  const add = (code: ExclusionCode, reason?: string) => { if (!out.some((x) => x.code === code)) out.push(finding(path, code, reason)); };
  let budget = 20_000;
  const visit = (value: unknown, depth: number): void => {
    if (budget-- <= 0 || depth > 4) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (!isRecord(value)) return;
    const contractLike = (has(value, "provider", "engine") && (has(value, "targets") || has(value, "killSwitchPath"))) || has(value, "authorize");
    if (contractLike && (value.enabled === true || authorizes(value.authorize))) add("ENABLED_CONTRACT", "a pilot contract that is enabled or carries an authorize entry");
    if (value.type === "service_account" && has(value, "private_key")) add("CLOUD_CREDENTIALS", "a cloud service account key file");
    if (has(value, "artifactSha256", "planSha256", "manifestHash")) add("SEALED_PLAN");
    if (has(value, "artifactSha256", "approverId", "nonce")) add("SIGNED_APPROVAL");
    if (has(value, "terraform_version", "lineage", "serial")) add("TERRAFORM_STATE", "Terraform state, by its content (terraform_version, lineage, serial)");
    if (has(value, "format_version", "terraform_version") && (has(value, "resource_changes") || has(value, "planned_values"))) add("SAVED_PLAN", "a Terraform plan in JSON form, by its content");
    for (const child of Object.values(value)) if (typeof child === "object" && child !== null) visit(child, depth + 1);
  };
  visit(root, 0);
  return out;
}

/** Source and bundle files, whose object literals read like YAML lines; they are judged by every other rule, not this one. */
const CODE_FILE = /\.(?:[cm]?js|tsx?|jsx|map|css|html?)$/i;
/** A YAML pilot contract: an `authorize` mapping that names an environment, or an enabled provider and engine pair. */
function yamlContract(text: string): boolean {
  if (/^\s*authorize:\s*(?:\{[^}\n]*\b(?:DEV|QA|PROD)\b|\r?\n\s+(?:DEV|QA|PROD)\s*:)/im.test(text)) return true;
  return /^\s*enabled:\s*true\s*$/im.test(text) && /^\s*provider:\s*["']?(?:AWS|AZURE|GCP)\b/im.test(text) && /^\s*engine:\s*\S/im.test(text);
}

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
/**
 * The entries of a zip archive, read from its central directory without extracting anything to disk: each name, and its bytes
 * when it is stored or deflated (inflated in memory, bounded). Undefined when the directory cannot be read.
 */
export function zipEntries(bytes: Buffer): { name: string; data?: Buffer }[] | undefined {
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= min; at--) {
    if (bytes.readUInt32LE(at) !== ZIP_END) continue;
    const count = bytes.readUInt16LE(at + 10);
    let offset = bytes.readUInt32LE(at + 16);
    const entries: { name: string; data?: Buffer }[] = [];
    for (let i = 0; i < count; i++) {
      if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== ZIP_CENTRAL) return undefined;
      const method = bytes.readUInt16LE(offset + 10);
      const compressed = bytes.readUInt32LE(offset + 20);
      const nameLength = bytes.readUInt16LE(offset + 28);
      const extra = bytes.readUInt16LE(offset + 30);
      const comment = bytes.readUInt16LE(offset + 32);
      const local = bytes.readUInt32LE(offset + 42);
      if (offset + 46 + nameLength > bytes.length) return undefined;
      const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      let data: Buffer | undefined;
      if (local + 30 <= bytes.length && bytes.readUInt32LE(local) === ZIP_LOCAL) {
        const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
        const raw = start + compressed <= bytes.length ? bytes.subarray(start, start + compressed) : undefined;
        try {
          if (raw && method === 0) data = Buffer.from(raw);
          else if (raw && method === 8) data = inflateRawSync(raw, { maxOutputLength: 64 * 1024 * 1024 });
        } catch { data = undefined; }
      }
      entries.push({ name, data: name.endsWith("/") ? Buffer.alloc(0) : data });
      offset += 46 + nameLength + extra + comment;
    }
    return entries;
  }
  return undefined;
}
/** The entry names of a zip archive, or undefined when its directory cannot be read. */
export const zipEntryNames = (bytes: Buffer): string[] | undefined => zipEntries(bytes)?.map((entry) => entry.name);
const PLAN_ENTRY = /^(?:tfplan|tfstate|tfstate-prev|tfconfig\/.*)$/;

/** The text forms of a file worth matching: as read, UTF-16 decoded, one gzip layer, and one base64 layer. Each is cheap to skip. */
function views(bytes: Buffer): string[] {
  const out: string[] = [];
  const addText = (buffer: Buffer) => {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) { out.push(new TextDecoder("utf-16le").decode(buffer.subarray(2))); return; }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) { out.push(new TextDecoder("utf-16be").decode(buffer.subarray(2))); return; }
    const sample = buffer.subarray(0, 4096);
    const nul = sample.reduce((n, byte) => n + (byte === 0 ? 1 : 0), 0);
    if (sample.length >= 8 && nul * 3 >= sample.length) out.push(new TextDecoder(sample[0] === 0 ? "utf-16be" : "utf-16le").decode(buffer));
    const text = buffer.toString("utf8");
    out.push(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  };
  const gunzip = (buffer: Buffer): Buffer | undefined => {
    if (buffer.length < 2 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) return undefined;
    try { return gunzipSync(buffer, { maxOutputLength: 64 * 1024 * 1024 }); } catch { return undefined; }
  };
  addText(bytes);
  const unzipped = gunzip(bytes);
  if (unzipped) addText(unzipped);
  const compact = bytes.length <= 16 * 1024 * 1024 ? bytes.toString("latin1").replace(/\s+/g, "") : "";
  if (compact.length >= 24 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) {
    const decoded = Buffer.from(compact, compact.includes("-") || compact.includes("_") ? "base64url" : "base64");
    addText(decoded);
    const inner = gunzip(decoded);
    if (inner) addText(inner);
  }
  return out;
}

/**
 * The findings for one file's bytes, under any name. Secrets are matched by their own patterns; JSON (any extension, BOM or
 * UTF-16, one gzip or base64 layer, nested in arrays or objects) is judged by shape: an enabled contract, a sealed plan, a signed
 * approval, Terraform state or a JSON plan. A zip is judged by its directory: one holding a Terraform plan's entries is a saved
 * plan, and a zip whose directory cannot be read fails closed.
 */
export function contentExclusions(path: string, bytes: Buffer, depth = 0): ExclusionFinding[] {
  const out: ExclusionFinding[] = [];
  const add = (code: ExclusionCode, reason: string) => { if (!out.some((x) => x.code === code && x.reason === reason)) out.push(finding(path, code, reason)); };
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === ZIP_LOCAL) {
    const entries = zipEntries(bytes);
    if (entries === undefined) add("UNREADABLE", "a zip archive whose directory cannot be read");
    else {
      if (entries.some((entry) => PLAN_ENTRY.test(entry.name))) add("SAVED_PLAN", "a saved Terraform plan (a zip holding tfplan, tfstate or tfconfig entries)");
      // One level in: each stored or deflated entry is judged by name and content, as a file of the package would be.
      for (const entry of entries) {
        if (depth > 0) break;
        if (entry.data === undefined) { add("UNREADABLE", "a zip entry that cannot be read in memory: " + entry.name); continue; }
        for (const found of [...pathExclusions(entry.name), ...contentExclusions(entry.name, entry.data, depth + 1)]) add(found.code, "inside the zip, " + entry.name + ": " + found.reason);
      }
    }
  }
  for (const text of views(bytes)) {
    if (PEM_PRIVATE_KEY.test(text) || PUTTY_KEY.test(text) || KUBE_CLIENT_KEY.test(text)) add("PRIVATE_KEY", "the file holds a private key");
    if (JWT.test(text)) add("TOKEN", "the file holds a JWT");
    if (GITHUB_TOKEN.test(text)) add("TOKEN", "the file holds a GitHub token");
    if (AWS_ACCESS_KEY_ID.test(text)) add("TOKEN", "the file holds an AWS access key id");
    if (AWS_SECRET.test(text)) add("TOKEN", "the file holds an AWS secret access key");
    if (INI_SECTION.test(text) && AWS_INI_KEY.test(text)) add("CLOUD_CREDENTIALS", "an AWS shared credentials file");
    if (AZURE_ACCOUNT_KEY.test(text) || AZURE_SAS_STRING.test(text)) add("TOKEN", "the file holds an Azure storage key or connection string");
    if (sasUrl(text)) add("TOKEN", "the file holds an Azure shared access signature URL");
    if (!CODE_FILE.test(path) && yamlContract(text)) add("ENABLED_CONTRACT", "a pilot contract in YAML form that is enabled or carries an authorize entry");
    // NUL padding around a JSON document does not hide it.
    const trimmed = text.replace(/^[\s\u0000]+|[\s\u0000]+$/g, "");
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let value: unknown;
      try { value = JSON.parse(trimmed); } catch { value = undefined; }
      for (const found of shapeFindings(path, value)) add(found.code, found.reason);
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
