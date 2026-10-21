import { createHash } from "node:crypto";
import { posix } from "node:path";

/** Offline *byte integrity and layout* preflight, not LZA YAML/schema validation. */
export type LzaIntakeFile = { path: string; content: string; sha256: string };
export type LzaIntakeMode = "PERSONAL_SANDBOX" | "ENTERPRISE_LZA";
export type LzaIntakeReport = {
  mode: LzaIntakeMode;
  verdict: "REJECTED" | "REVIEW_REQUIRED";
  sourceClass: "DECLARED_LOCAL_FILES";
  completeCoreFileSet: boolean;
  presentCoreFiles: string[];
  missingCoreFiles: string[];
  resolvedIncludes: number;
  issues: string[];
  fileDigests: Array<{path: string; sha256: string}>;
  bundleSha256?: string;
  schemaValidation: "NOT_RUN";
  cloudEvidence: "NOT_RUN";
  deploymentAuthorized: false;
  actEnabled: false;
};
export const CORE_LZA_CONFIG_FILES = [
  "accounts-config.yaml", "global-config.yaml", "iam-config.yaml",
  "network-config.yaml", "organization-config.yaml", "security-config.yaml"
] as const;
const OPTIONAL = new Set(["customizations-config.yaml", "replacements-config.yaml"]);
const HEX = /^[0-9a-f]{64}$/;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const MAX_BYTES = 2_000_000;
const MAX_FILES = 256;
const MAX_TOTAL_BYTES = 8_000_000;
const hash = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
function validPath(p: unknown): p is string {
  return typeof p === "string" && SAFE_PATH.test(p) &&
    !p.startsWith("/") && !p.endsWith("/") &&
    !p.split("/").some(segment => segment === "." || segment === ".." || segment.length===0) &&
    posix.normalize(p) === p;
}
function includeTargets(content: string): string[] {
  // LZA's custom !include loader is not a standard YAML parser. Collect
  // only explicit simple scalar forms; advanced YAML requires schema review.
  const result: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const cleaned = line.replace(/\s+#.*$/, "");
    if (/^\s*#/.test(cleaned)) continue;
    const m = cleaned.match(/!include\s+(?:["']([^"']+)["']|([^\s,#\[\]{}]+))/g) ?? [];
    for (const occurrence of m) {
      const path = occurrence.replace(/^!include\s+/, "").replace(/^["']|["']$/g, "");
      result.push(path);
    }
  }
  return result;
}
export function inspectLzaConfiguration(
  files: readonly LzaIntakeFile[],
  mode: LzaIntakeMode
): LzaIntakeReport {
  const issues: string[] = [];
  const byPath = new Map<string,string>();
  const digests: LzaIntakeReport["fileDigests"] = [];
  let bytes = 0;
  if (!["PERSONAL_SANDBOX","ENTERPRISE_LZA"].includes(mode))
    issues.push("MODE_INVALID");
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES)
    issues.push("FILE_SET_INVALID");
  for (const file of Array.isArray(files) ? files.slice(0,MAX_FILES) : []) {
    if (!file || !validPath(file.path)) { issues.push("PATH_INVALID"); continue; }
    if (byPath.has(file.path)) { issues.push("DUPLICATE_PATH:" + file.path); continue; }
    if (typeof file.content !== "string") { issues.push("CONTENT_INVALID:" + file.path); continue; }
    const size = Buffer.byteLength(file.content,"utf8");
    bytes += size;
    if (size === 0 || size > MAX_BYTES) { issues.push("FILE_SIZE_INVALID:" + file.path); continue; }
    const computed = hash(file.content);
    if (!HEX.test(file.sha256 ?? "") || file.sha256 !== computed)
      issues.push("CONTENT_HASH_MISMATCH:" + file.path);
    byPath.set(file.path,file.content);
    digests.push({path:file.path,sha256:computed});
  }
  if (bytes > MAX_TOTAL_BYTES) issues.push("BUNDLE_SIZE_INVALID");
  const presentCoreFiles = CORE_LZA_CONFIG_FILES.filter(path => byPath.has(path));
  const missingCoreFiles = CORE_LZA_CONFIG_FILES.filter(path => !byPath.has(path));
  // Never characterize partial personal-account configurations as a valid
  // multi-account LZA configuration or translate these directly to IaC.
  if (mode === "ENTERPRISE_LZA" && missingCoreFiles.length)
    issues.push("REQUIRED_LZA_FILES_MISSING");
  for (const name of byPath.keys()) {
    if (!name.includes("/") && !CORE_LZA_CONFIG_FILES.includes(name as typeof CORE_LZA_CONFIG_FILES[number]) && !OPTIONAL.has(name))
      issues.push("UNRECOGNIZED_ROOT_FILE:" + name);
  }
  const edges = new Map<string,string[]>();
  let resolvedIncludes = 0;
  for (const [name,content] of byPath) {
    const refs: string[] = [];
    for (const ref of includeTargets(content)) {
      const target = posix.normalize(posix.join(posix.dirname(name),ref));
      if (!validPath(ref) || !validPath(target) || !byPath.has(target)) {
        issues.push("INCLUDE_UNRESOLVED:" + name); continue;
      }
      refs.push(target);
      resolvedIncludes++;
    }
    edges.set(name,refs);
  }
  const active = new Set<string>();
  const visited = new Set<string>();
  const walk = (name:string):void => {
    if (active.has(name)) {issues.push("INCLUDE_CYCLE:" + name); return;}
    if (visited.has(name))return;
    active.add(name);
    for (const next of edges.get(name)??[])walk(next);
    active.delete(name);visited.add(name);
  };
  for (const name of byPath.keys())walk(name);
  digests.sort((a,b)=>a.path.localeCompare(b.path));
  const report: LzaIntakeReport = {
    mode,verdict:issues.length ? "REJECTED" : "REVIEW_REQUIRED",
    sourceClass:"DECLARED_LOCAL_FILES",
    completeCoreFileSet:missingCoreFiles.length === 0,
    presentCoreFiles:[...presentCoreFiles],missingCoreFiles:[...missingCoreFiles],
    resolvedIncludes,issues:[...new Set(issues)],fileDigests:digests,
    schemaValidation:"NOT_RUN",cloudEvidence:"NOT_RUN",
    deploymentAuthorized:false,actEnabled:false
  };
  if (!issues.length)
    report.bundleSha256=hash(JSON.stringify(digests));
  return report;
}
