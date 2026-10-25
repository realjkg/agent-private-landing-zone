import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Reads what a Terraform root module needs from outside its files, for `./alz apply prepare` (src/apply/prepare.ts): its
 * variables, where each one's value comes from, and the source of every module it calls. It reads names and sources only and
 * never keeps a value, a default or a variable's text. HCL is scanned, not evaluated: comments, heredocs and interpolated
 * strings are skipped so a brace or an equals sign inside them is never read as structure.
 */

export type TerraformVariable = { name: string; hasDefault: boolean; file: string };
export type TerraformModule = { name: string; source: string; file: string };
/** Where a root variable's value comes from, in Terraform's order of precedence. Never the value itself. */
export type VariableSource =
  | { kind: "TFVARS"; file: string }
  | { kind: "ENVIRONMENT"; variable: string }
  | { kind: "DEFAULT"; file: string }
  | { kind: "UNSET" };

export class TerraformConfigError extends Error {
  constructor(readonly code: "TERRAFORM_CONFIG_UNREADABLE" | "MODULE_REMOTE" | "MODULE_OUTSIDE_PROJECT", message: string) { super(message); }
}

type Token = { kind: "ident" | "string" | "punct"; text: string; depth: number };

/** Tokens of HCL text: identifiers, string literals (their literal text, or "" when interpolated) and { } = with brace depth. */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  let depth = 0;
  let i = 0;
  const fail = (): never => { throw new TerraformConfigError("TERRAFORM_CONFIG_UNREADABLE", "A Terraform file could not be read: an unterminated string, comment or heredoc."); };
  /** Reads a quoted string starting after its opening quote; returns its end and whether it held an interpolation. */
  const readString = (start: number): { end: number; literal: string; interpolated: boolean } => {
    let j = start;
    let literal = "";
    let interpolated = false;
    while (j < text.length) {
      const c = text[j];
      if (c === "\\") { literal += text.slice(j, j + 2); j += 2; continue; }
      if (c === '"') return { end: j + 1, literal, interpolated };
      if ((c === "$" || c === "%") && text[j + 1] === "{") {
        interpolated = true;
        let inner = 1;
        j += 2;
        while (j < text.length && inner > 0) {
          if (text[j] === '"') { j = readString(j + 1).end; continue; }
          if (text[j] === "{") inner += 1;
          else if (text[j] === "}") inner -= 1;
          j += 1;
        }
        continue;
      }
      if (c === "\n") fail();
      literal += c;
      j += 1;
    }
    return fail();
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "#" || (c === "/" && text[i + 1] === "/")) { while (i < text.length && text[i] !== "\n") i += 1; continue; }
    if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); if (end < 0) fail(); i = end + 2; continue; }
    if (c === "<" && text[i + 1] === "<") {
      const heredoc = /^<<-?([A-Za-z_][A-Za-z0-9_]*)\r?\n/.exec(text.slice(i));
      if (heredoc) {
        const marker = heredoc[1];
        let j = i + heredoc[0].length;
        for (;;) {
          const lineEnd = text.indexOf("\n", j);
          const line = text.slice(j, lineEnd < 0 ? text.length : lineEnd);
          if (line.trim() === marker) { i = lineEnd < 0 ? text.length : lineEnd; break; }
          if (lineEnd < 0) fail();
          j = lineEnd + 1;
        }
        out.push({ kind: "string", text: "", depth });
        continue;
      }
    }
    if (c === '"') {
      const read = readString(i + 1);
      out.push({ kind: "string", text: read.interpolated ? "" : read.literal, depth });
      i = read.end;
      continue;
    }
    if (c === "{") { out.push({ kind: "punct", text: "{", depth }); depth += 1; i += 1; continue; }
    if (c === "}") { depth -= 1; if (depth < 0) fail(); out.push({ kind: "punct", text: "}", depth }); i += 1; continue; }
    if (c === "=") {
      // An assignment, not ==, !=, <=, >= or =>.
      const assignment = text[i + 1] !== "=" && text[i + 1] !== ">" && !"=!<>".includes(text[i - 1] ?? "");
      if (assignment) out.push({ kind: "punct", text: "=", depth });
      i += 1;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(i, i + 256));
    if (ident) { out.push({ kind: "ident", text: ident[0], depth }); i += ident[0].length; continue; }
    i += 1;
  }
  if (depth !== 0) fail();
  return out;
}

/** Top-level blocks of one type (`variable`, `module`) with their first label and their depth-1 attributes. */
function blocks(text: string, type: string): Array<{ label: string; attributes: Map<string, Token | undefined> }> {
  const list = tokens(text);
  const found: Array<{ label: string; attributes: Map<string, Token | undefined> }> = [];
  for (let k = 0; k < list.length; k += 1) {
    const t = list[k];
    if (t.depth !== 0 || t.kind !== "ident" || t.text !== type) continue;
    const label = list[k + 1];
    if (!label || (label.kind !== "string" && label.kind !== "ident") || list[k + 2]?.text !== "{") continue;
    const attributes = new Map<string, Token | undefined>();
    let m = k + 3;
    for (; m < list.length && !(list[m].text === "}" && list[m].depth === 0); m += 1) {
      if (list[m].depth === 1 && list[m].kind === "ident" && list[m + 1]?.text === "=" && list[m + 1]?.depth === 1) attributes.set(list[m].text, list[m + 2]);
    }
    found.push({ label: label.text, attributes });
    k = m;
  }
  return found;
}

const read = (path: string): string => {
  try { return readFileSync(path, "utf8"); } catch { throw new TerraformConfigError("TERRAFORM_CONFIG_UNREADABLE", "A Terraform file could not be read."); }
};
const parseJson = (path: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(read(path)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof TerraformConfigError) throw error;
    throw new TerraformConfigError("TERRAFORM_CONFIG_UNREADABLE", "A Terraform JSON file is not valid JSON.");
  }
};
const filesOf = (dir: string, suffix: string): string[] => readdirSync(dir).filter((name) => name.endsWith(suffix) && statSync(join(dir, name)).isFile()).sort();

/** The variables a module directory declares, from its .tf and .tf.json files. */
export function declaredVariables(dir: string): TerraformVariable[] {
  const variables: TerraformVariable[] = [];
  for (const file of filesOf(dir, ".tf")) {
    for (const block of blocks(read(join(dir, file)), "variable")) variables.push({ name: block.label, hasDefault: block.attributes.has("default"), file });
  }
  for (const file of filesOf(dir, ".tf.json")) {
    const declared = parseJson(join(dir, file)).variable;
    if (declared && typeof declared === "object") {
      for (const [name, body] of Object.entries(declared as Record<string, unknown>)) {
        variables.push({ name, hasDefault: !!body && typeof body === "object" && Object.hasOwn(body, "default"), file });
      }
    }
  }
  return variables.sort((a, b) => a.name.localeCompare(b.name));
}

/** The module calls a module directory makes, from its .tf and .tf.json files. */
function moduleCalls(dir: string): TerraformModule[] {
  const calls: TerraformModule[] = [];
  for (const file of filesOf(dir, ".tf")) {
    for (const block of blocks(read(join(dir, file)), "module")) {
      const source = block.attributes.get("source");
      calls.push({ name: block.label, source: source?.kind === "string" ? source.text : "", file });
    }
  }
  for (const file of filesOf(dir, ".tf.json")) {
    const declared = parseJson(join(dir, file)).module;
    if (declared && typeof declared === "object") {
      for (const [name, body] of Object.entries(declared as Record<string, unknown>)) {
        const source = body && typeof body === "object" ? (body as Record<string, unknown>).source : undefined;
        calls.push({ name, source: typeof source === "string" ? source : "", file });
      }
    }
  }
  return calls;
}

/**
 * Every module the root calls, followed through local modules. A local module must stay inside the project, because only the
 * project's files are fingerprinted. A remote module (registry, Git, HTTP, S3, ...) is refused: neither the lock file nor the
 * project fingerprint binds its code, so a sealed plan could run code nobody reviewed.
 */
export function checkModules(projectRoot: string): TerraformModule[] {
  const root = realpathSync(projectRoot);
  const seen = new Set<string>();
  const all: TerraformModule[] = [];
  const visit = (dir: string): void => {
    if (seen.has(dir)) return;
    seen.add(dir);
    for (const call of moduleCalls(dir)) {
      all.push({ ...call, file: relative(root, join(dir, call.file)) });
      if (!call.source.startsWith("./") && !call.source.startsWith("../")) {
        throw new TerraformConfigError("MODULE_REMOTE", "Module \"" + call.name + "\" comes from " + (call.source === "" ? "a source that is not a plain string" : "outside the project (" + call.source.slice(0, 120) + ")") +
          ". Its code is not bound by the lock file or the project fingerprint, so it cannot be sealed. Copy it into the project and call it with a ./ path.");
      }
      const target = resolve(dir, call.source);
      const real = existsSync(target) ? realpathSync(target) : "";
      if (real === "" || (real !== root && !real.startsWith(root + sep)) || !statSync(real).isDirectory()) {
        throw new TerraformConfigError("MODULE_OUTSIDE_PROJECT", "Module \"" + call.name + "\" points to " + call.source.slice(0, 120) + ", which is not a folder inside the project. Only the project's own files are fingerprinted.");
      }
      visit(real);
    }
  };
  visit(root);
  return all;
}

/** Variable names a .tfvars or .tfvars.json file assigns. */
function assigned(path: string): Set<string> {
  if (path.endsWith(".json")) return new Set(Object.keys(parseJson(path)));
  return new Set(tokens(read(path)).flatMap((t, k, list) => t.depth === 0 && t.kind === "ident" && list[k + 1]?.text === "=" ? [t.text] : []));
}

/**
 * Where each root variable's value comes from, in Terraform's precedence: *.auto.tfvars(.json) in lexical order (the last
 * wins), then terraform.tfvars.json, then terraform.tfvars, then the plan identity's TF_VAR_ variable, then the default.
 * The seal plans as the DISCOVERY identity, so an environment value is `ALZ_DISCOVERY_TF_VAR_<name>`. Values are never read.
 */
export function variableSources(projectRoot: string, env: NodeJS.ProcessEnv): Array<TerraformVariable & { source: VariableSource }> {
  const autoFiles = readdirSync(projectRoot).filter((name) => /\.auto\.tfvars(\.json)?$/.test(name) && statSync(join(projectRoot, name)).isFile()).sort();
  const ordered = [...autoFiles.reverse(), "terraform.tfvars.json", "terraform.tfvars"].filter((name) => existsSync(join(projectRoot, name)));
  const byFile = ordered.map((file) => ({ file, names: assigned(join(projectRoot, file)) }));
  return declaredVariables(projectRoot).map((variable) => {
    const fromFile = byFile.find((entry) => entry.names.has(variable.name));
    const envName = "ALZ_DISCOVERY_TF_VAR_" + variable.name;
    const source: VariableSource = fromFile ? { kind: "TFVARS", file: fromFile.file }
      : env[envName] !== undefined ? { kind: "ENVIRONMENT", variable: envName }
      : variable.hasDefault ? { kind: "DEFAULT", file: variable.file } : { kind: "UNSET" };
    return { ...variable, source };
  });
}
