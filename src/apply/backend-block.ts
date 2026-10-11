import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stop } from "./engine.js";
import { isRecord } from "./providers/shared.js";

/**
 * The project's own backend block, judged before `terraform init` reads it (docs/act-pilot-apply.md, "Providers").
 * Init already sends credentials to whatever its backend settings name (an endpoint, a role, static keys), so a check
 * of what init saved cannot protect init itself. The root module's `.tf` and `.tf.json` files are read here, and
 * every `backend` block must be the spec's type with attributes from its allowlist. A `cloud` block is another backend and is refused.
 * Anything that cannot be parsed is refused: this is a reader of the block only, not an HCL implementation.
 */
export type BackendBlockRule = { type: string; attributes: readonly string[] };

const CODE = "BACKEND_BLOCK_NOT_IN_CONTRACT";
const MAX_FILE_BYTES = 1_048_576;

type Token = { kind: "id" | "str" | "sym" | "nl"; text: string };
type Found = { type: string; keys: string[] } | "cloud";

/** Comments, strings (with `${ }` templates, which may hold strings), heredocs and everything else as single symbols. */
function tokenize(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const string = (from: number): number => {
    for (let at = from; at < source.length; at++) {
      const c = source[at];
      if (c === "\\") at++;
      else if (c === '"') return at + 1;
      else if ((c === "$" || c === "%") && source[at + 1] === "{") at = template(at + 2) - 1;
      else if (c === "$" && source.startsWith("${", at + 1)) at += 2;
    }
    return stop(CODE);
  };
  const template = (from: number): number => {
    let depth = 1;
    for (let at = from; at < source.length; at++) {
      const c = source[at];
      if (c === '"') at = string(at + 1) - 1;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return at + 1;
    }
    return stop(CODE);
  };
  while (i < source.length) {
    const c = source[i];
    const heredoc = c === "<" && /^<<-?([A-Za-z_][A-Za-z0-9_]*)\r?\n/.exec(source.slice(i, i + 140));
    if (c === "\n") { out.push({ kind: "nl", text: c }); i++; }
    else if (/\s/.test(c)) i++;
    else if (c === "#" || source.startsWith("//", i)) { while (i < source.length && source[i] !== "\n") i++; }
    else if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); i = end < 0 ? stop(CODE) : end + 2; }
    else if (heredoc) {
      const end = new RegExp("^[ \\t]*" + heredoc[1] + "[ \\t]*\\r?$", "m").exec(source.slice(i + heredoc[0].length));
      if (!end) return stop(CODE);
      out.push({ kind: "str", text: "" });
      i += heredoc[0].length + end.index + end[0].length;
    } else if (c === '"') { const end = string(i + 1); out.push({ kind: "str", text: source.slice(i + 1, end - 1) }); i = end; }
    else {
      const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(i, i + 128));
      out.push(id ? { kind: "id", text: id[0] } : { kind: "sym", text: c });
      i += id ? id[0].length : 1;
    }
  }
  return out;
}

const OPEN = "([{";
const CLOSE = ")]}";

/** Reads `terraform { ... }` bodies; every other top-level block is skipped by its braces. */
function blocksOf(tokens: Token[]): Found[] {
  const found: Found[] = [];
  const is = (at: number, text: string): boolean => tokens[at]?.kind === "sym" && tokens[at].text === text;
  const skipBalanced = (open: number): number => {
    let depth = 0;
    for (let at = open; at < tokens.length; at++) {
      if (is(at, "{")) depth++;
      else if (is(at, "}") && --depth === 0) return at + 1;
    }
    return stop(CODE);
  };
  /** The items of a body starting after its `{`: `[key, labels, index of the block's own `{` or -1 for an attribute]`. Returns the index after the `}`. */
  const body = (from: number, onItem: (key: string, labels: string[], open: number) => void): number => {
    let at = from;
    for (;;) {
      while (tokens[at]?.kind === "nl") at++;
      if (at >= tokens.length) return stop(CODE);
      if (is(at, "}")) return at + 1;
      const key = tokens[at++];
      if (key.kind !== "id" && key.kind !== "str") return stop(CODE);
      if (is(at, "=")) {
        let depth = 0;
        for (at++; at < tokens.length && !(depth === 0 && (tokens[at].kind === "nl" || is(at, "}"))); at++) {
          if (depth === 0 && is(at, ",")) return stop(CODE);
          if (tokens[at].kind === "sym" && OPEN.includes(tokens[at].text)) depth++;
          else if (tokens[at].kind === "sym" && CLOSE.includes(tokens[at].text)) depth--;
          if (depth < 0) return stop(CODE);
        }
        onItem(key.text, [], -1);
        continue;
      }
      const labels: string[] = [];
      while (tokens[at]?.kind === "str" || tokens[at]?.kind === "id") labels.push(tokens[at++].text);
      if (!is(at, "{")) return stop(CODE);
      onItem(key.text, labels, at);
      at = skipBalanced(at);
    }
  };
  for (let at = 0; at < tokens.length;) {
    if (tokens[at].kind === "id" && tokens[at].text === "terraform" && is(at + 1, "{")) {
      at = body(at + 2, (key, labels, open) => {
        if (key === "cloud") found.push("cloud");
        else if (key === "backend" && open >= 0 && labels.length === 1) {
          const keys: string[] = [];
          body(open + 1, (name) => { keys.push(name); });
          found.push({ type: labels[0], keys });
        } else if (key === "backend") stop(CODE);
      });
    } else if (is(at, "{")) at = skipBalanced(at);
    else at++;
  }
  return found;
}

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

function blocksOfJson(source: string): Found[] {
  let document: unknown;
  try { document = JSON.parse(source); } catch { return stop(CODE); }
  const found: Found[] = [];
  for (const terraform of isRecord(document) ? listOf(document.terraform).filter(isRecord) : []) {
    if (Object.hasOwn(terraform, "cloud")) found.push("cloud");
    for (const backend of listOf(terraform.backend).filter(isRecord)) {
      for (const [type, settings] of Object.entries(backend)) {
        found.push({ type, keys: listOf(settings).filter(isRecord).flatMap((s) => Object.keys(s)) });
      }
    }
  }
  return found;
}

/** Throws BACKEND_BLOCK_NOT_IN_CONTRACT unless every backend block in the root module's files is the rule's type with allowed attributes only. */
export function assertBackendBlock(directory: string, rule: BackendBlockRule): void {
  for (const name of readdirSync(directory).filter((n) => /\.tf(\.json)?$/.test(n))) {
    const file = join(directory, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) stop(CODE);
    const source = readFileSync(file, "utf8");
    const blocks = name.endsWith(".json") ? blocksOfJson(source) : blocksOf(tokenize(source));
    for (const block of blocks) {
      if (block === "cloud" || block.type !== rule.type || block.keys.some((key) => !rule.attributes.includes(key))) stop(CODE);
    }
  }
}
