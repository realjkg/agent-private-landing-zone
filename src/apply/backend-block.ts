import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stop } from "./engine.js";

/**
 * The project's own backend block, judged before `terraform init` reads it (docs/act-pilot-apply.md, "Providers").
 * Init already sends credentials to whatever its backend settings name (an endpoint, a role, static keys), so a check
 * of what init saved cannot protect init itself. The root module's `.tf` and `.tf.json` files are read here, and
 * every `backend` block must be the spec's type with attributes from its allowlist, and an attribute the rule pins must be
 * that literal value for the contract's backend (`literals`: the storage names, a switch that must be on). A `terraform`
 * block may hold nothing else that could say where state goes (`TERRAFORM_ITEMS`; a `cloud` block is another backend). Anything that cannot be parsed is refused: this is a reader of the block only, not an
 * HCL implementation, but it tokenizes as hclsyntax does and refuses whatever it cannot follow (`tokenize`).
 */
export type BackendBlockRule = {
  type: string;
  attributes: readonly string[];
  /**
   * Attribute name to the one literal value the block may give it, for the contract's backend string. An attribute the block
   * sets to anything else, or to an expression (init cannot read one in a backend block either, and nothing would judge it
   * before init), is refused. An attribute the block leaves out is the partial configuration's or the environment's to fill.
   */
  literals?: (backend: string) => Readonly<Record<string, string | boolean>>;
};

const CODE = "BACKEND_BLOCK_NOT_IN_CONTRACT";
const MAX_FILE_BYTES = 1_048_576;
/** Template sequences inside template sequences beyond this are refused rather than followed. */
const MAX_NESTING = 32;

/**
 * `expr` is a value that is never a literal (a heredoc). Templates in quoted strings stay in the `str` token's text, so a
 * string holding one is an expression too (`literalOf`).
 */
type Token = { kind: "id" | "str" | "expr" | "sym" | "nl"; text: string };
/** An attribute's value: a string or boolean literal, or `EXPRESSION` for anything else (a reference, a template, a heredoc, a number, a nested block). */
const EXPRESSION = Symbol("expression");
type Literal = string | boolean | typeof EXPRESSION;
type Found = { type: string; keys: string[]; values: Map<string, Literal> };

/**
 * What a `terraform` block may hold: its required version and providers, and the backend this rule judges. Anything else is
 * refused, in either syntax: a `cloud` block (another backend), a `state_store` block, `experiments`, `provider_meta` or a
 * name this code does not know, so no other way to say where state goes, or to change how init reads the block, is left
 * unjudged.
 */
const TERRAFORM_ITEMS = new Set(["required_version", "required_providers", "backend"]);

/** The literal a value's tokens spell: one plain string, or `true` / `false`; anything else is an expression. */
function literalOf(tokens: readonly Token[]): Literal {
  if (tokens.length !== 1) return EXPRESSION;
  const [token] = tokens;
  if (token.kind === "str") return token.text.includes("${") || token.text.includes("%{") || token.text.includes("\\") ? EXPRESSION : token.text;
  if (token.kind === "id" && (token.text === "true" || token.text === "false")) return token.text === "true";
  return EXPRESSION;
}

/** HCL's single-character tokens that a valid configuration can hold outside strings (hclsyntax `SelfToken`, less `^ ; \` '`). */
const SYMBOLS = "[]().,*/%+-=<>!?:&|{}";
const IDENT = /[A-Za-z_][A-Za-z0-9_-]*/y;
const HEREDOC = /<<-?([A-Za-z_][A-Za-z0-9_-]*)\r?\n/y;
/** Go's `bytes.TrimSpace`, which hclsyntax applies to a heredoc line to find its closing marker: Unicode White_Space at both ends. */
const trimSpace = (line: string): string => line.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");

/**
 * The tokens of an HCL native-syntax file, following hclsyntax's scanner (`scan_tokens.rl`, hashicorp/hcl v2) for every mode
 * that can hide or reveal a block: comments, quoted templates (with `${ }` and `%{ }` sequences, whose expressions may hold
 * strings, heredocs and braces, and the `$${` and `%%{` escapes), heredocs (`<<` or `<<-` and an identifier that may contain
 * `-`, closed by a line that is only that identifier), and braces. It refuses rather than guesses: a character or sequence
 * outside that model (a non-ASCII identifier, a `<<` that is not a heredoc opener, a `$` outside a template, a raw newline in a
 * quoted string, a lone carriage return, invalid UTF-8, an unterminated string, comment, heredoc or template) is
 * BACKEND_BLOCK_NOT_IN_CONTRACT, never skipped. hclsyntax rejects each of them too, so a valid configuration is not refused
 * for them, except one with a non-ASCII identifier or heredoc marker, or with template sequences nested beyond `MAX_NESTING`.
 */
function tokenize(source: string): Token[] {
  const out: Token[] = [];
  /** At a `$` or `%` in a template: the index after an interpolation or directive it opens, or after the literal text it is. */
  let nesting = 0;
  const sequence = (at: number): number => {
    const c = source[at];
    if (source[at + 1] === "{") {
      if (++nesting > MAX_NESTING) return stop(CODE);
      const end = code(at + 2, true);
      nesting--;
      return end;
    }
    return source[at + 1] === c && source[at + 2] === "{" ? at + 3 : at + 1;
  };
  /** A quoted template's text after its opening `"`; returns the index after its closing `"`. */
  const quoted = (from: number): number => {
    for (let at = from; at < source.length;) {
      const c = source[at];
      if (c === '"') return at + 1;
      if (c === "\n" || c === "\r") return stop(CODE);
      if (c === "\\") {
        if (at + 1 >= source.length || source[at + 1] === "\n" || source[at + 1] === "\r") return stop(CODE);
        at += 2;
      } else at = c === "$" || c === "%" ? sequence(at) : at + 1;
    }
    return stop(CODE);
  };
  /**
   * A heredoc's lines from the one after its opener; returns the index of the closing marker line's terminator (`\r\n` or `\n`),
   * which is the attribute's newline. A line closes it only when no template sequence started on it.
   */
  const heredoc = (from: number, marker: string): number => {
    for (let at = from; ;) {
      const end = source.indexOf("\n", at);
      if (end < 0) return stop(CODE);
      const line = source.slice(at, end);
      if (line.slice(0, -1).includes("\r")) return stop(CODE);
      if (trimSpace(line) === marker) return line.endsWith("\r") ? end - 1 : end;
      let p = at;
      while (p < source.length && source[p] !== "\n") {
        const c = source[p];
        if (c === "\r" && source[p + 1] !== "\n") return stop(CODE);
        p = c === "$" || c === "%" ? sequence(p) : p + 1;
      }
      if (p >= source.length) return stop(CODE);
      at = p + 1;
    }
  };
  /**
   * Code from `from`. At the top level, every token is kept and the end of the file ends it. Inside a template sequence
   * (`nested`), the tokens are only followed, and the `}` (or `~}`) that closes the sequence ends it; returns the index after it.
   */
  const code = (from: number, nested: boolean): number => {
    let depth = 0;
    const emit = (token: Token): void => { if (!nested) out.push(token); };
    for (let i = from; i < source.length;) {
      const c = source[i];
      if (c === "\n" || (c === "\r" && source[i + 1] === "\n")) { emit({ kind: "nl", text: "\n" }); i += c === "\n" ? 1 : 2; }
      else if (c === " " || c === "\t") i++;
      else if (c === "#" || source.startsWith("//", i)) { while (i < source.length && source[i] !== "\n") i++; }
      else if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); i = end < 0 ? stop(CODE) : end + 2; }
      else if (c === '"') { const end = quoted(i + 1); emit({ kind: "str", text: source.slice(i + 1, end - 1) }); i = end; }
      else if (source.startsWith("<<", i)) {
        HEREDOC.lastIndex = i;
        const opener = HEREDOC.exec(source);
        if (!opener) return stop(CODE);
        i = heredoc(i + opener[0].length, opener[1]);
        emit({ kind: "expr", text: "<<" + opener[1] });
      } else if (source.startsWith("~}", i) || c === "}") {
        if (nested && depth === 0) return i + (c === "~" ? 2 : 1);
        if (c === "~") return stop(CODE);
        depth--;
        emit({ kind: "sym", text: c });
        i++;
      } else if (c === "{") { depth++; emit({ kind: "sym", text: c }); i++; }
      else if (c === "~" && nested) i++;
      else if (/[A-Za-z_]/.test(c)) {
        IDENT.lastIndex = i;
        const id = (IDENT.exec(source) as RegExpExecArray)[0];
        emit({ kind: "id", text: id });
        i += id.length;
      } else if (/[0-9]/.test(c) || SYMBOLS.includes(c)) { emit({ kind: "sym", text: c }); i++; }
      else return stop(CODE);
    }
    return nested ? stop(CODE) : source.length;
  };
  code(0, false);
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
  /**
   * The items of a body starting after its `{`: `[key, labels, index of the block's own `{` or -1 for an attribute, the attribute's
   * literal value]`. Returns the index after the `}`.
   */
  const body = (from: number, onItem: (key: string, labels: string[], open: number, value: Literal) => void): number => {
    let at = from;
    for (;;) {
      while (tokens[at]?.kind === "nl") at++;
      if (at >= tokens.length) return stop(CODE);
      if (is(at, "}")) return at + 1;
      const key = tokens[at++];
      if (key.kind !== "id" && key.kind !== "str") return stop(CODE);
      if (is(at, "=")) {
        let depth = 0;
        const start = at + 1;
        for (at++; at < tokens.length && !(depth === 0 && (tokens[at].kind === "nl" || is(at, "}"))); at++) {
          if (depth === 0 && is(at, ",")) return stop(CODE);
          if (tokens[at].kind === "sym" && OPEN.includes(tokens[at].text)) depth++;
          else if (tokens[at].kind === "sym" && CLOSE.includes(tokens[at].text)) depth--;
          if (depth < 0) return stop(CODE);
        }
        onItem(key.text, [], -1, literalOf(tokens.slice(start, at)));
        continue;
      }
      const labels: string[] = [];
      while (tokens[at]?.kind === "str" || tokens[at]?.kind === "id") labels.push(tokens[at++].text);
      if (!is(at, "{")) return stop(CODE);
      onItem(key.text, labels, at, EXPRESSION);
      at = skipBalanced(at);
    }
  };
  for (let at = 0; at < tokens.length;) {
    if (tokens[at].kind === "id" && tokens[at].text === "terraform" && is(at + 1, "{")) {
      at = body(at + 2, (key, labels, open) => {
        if (!TERRAFORM_ITEMS.has(key)) stop(CODE);
        else if (key === "backend" && open >= 0 && labels.length === 1) {
          const keys: string[] = [];
          const values = new Map<string, Literal>();
          // A name set twice is an expression: neither value is the one init would read.
          body(open + 1, (name, _labels, _open, value) => { keys.push(name); values.set(name, values.has(name) ? EXPRESSION : value); });
          found.push({ type: labels[0], keys, values });
        } else if (key === "backend") stop(CODE);
      });
    } else if (is(at, "{")) at = skipBalanced(at);
    else at++;
  }
  return found;
}

/** A JSON value as `.tf.json` holds it: objects keep their properties in order, in a map that a property name cannot alter. */
type Json = Map<string, Json> | Json[] | string | number | boolean | null;
/** JSON values inside JSON values beyond this are refused rather than followed. */
const MAX_JSON_DEPTH = 256;
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const JSON_ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * A strict JSON reader for `.tf.json` (RFC 8259), not `JSON.parse`: `JSON.parse` keeps only the last of a repeated property,
 * while HCL's JSON parser keeps every one (a repeated `terraform` or backend type is another block), so a repeated name could
 * hide a block from this reader that init reads. A property name repeated in any object, at any depth, is refused, as are a
 * byte order mark (hcl/json does not accept one), a property name that is not ASCII (so no Unicode normalization can make two
 * names one), an unpaired surrogate escape, trailing data, and nesting beyond `MAX_JSON_DEPTH`.
 */
function parseJson(source: string): Json {
  let i = 0;
  const space = (): void => { while (source[i] === " " || source[i] === "\t" || source[i] === "\n" || source[i] === "\r") i++; };
  const string = (): string => {
    let text = "";
    for (i++; i < source.length;) {
      const c = source[i];
      if (c === '"') { i++; return text; }
      if (c < " ") return stop(CODE);
      if (c !== "\\") { text += c; i++; continue; }
      const e = source[i + 1];
      if (e === "u") {
        const unit = (at: number): number => (/^[0-9a-fA-F]{4}$/.test(source.slice(at, at + 4)) ? parseInt(source.slice(at, at + 4), 16) : stop(CODE));
        const high = unit(i + 2);
        i += 6;
        if (high >= 0xdc00 && high <= 0xdfff) return stop(CODE);
        if (high >= 0xd800 && high <= 0xdbff) {
          if (source[i] !== "\\" || source[i + 1] !== "u") return stop(CODE);
          const low = unit(i + 2);
          if (low < 0xdc00 || low > 0xdfff) return stop(CODE);
          text += String.fromCharCode(high, low);
          i += 6;
        } else text += String.fromCharCode(high);
      } else if (e !== undefined && Object.hasOwn(JSON_ESCAPES, e)) { text += JSON_ESCAPES[e]; i += 2; }
      else return stop(CODE);
    }
    return stop(CODE);
  };
  const value = (depth: number): Json => {
    if (depth > MAX_JSON_DEPTH) return stop(CODE);
    space();
    const c = source[i];
    if (c === "{") {
      const object = new Map<string, Json>();
      i++;
      space();
      if (source[i] === "}") { i++; return object; }
      for (;;) {
        space();
        if (source[i] !== '"') return stop(CODE);
        const name = string();
        if (!/^[\x20-\x7e]*$/.test(name) || object.has(name)) return stop(CODE);
        space();
        if (source[i++] !== ":") return stop(CODE);
        object.set(name, value(depth + 1));
        space();
        const next = source[i++];
        if (next === "}") return object;
        if (next !== ",") return stop(CODE);
      }
    }
    if (c === "[") {
      const items: Json[] = [];
      i++;
      space();
      if (source[i] === "]") { i++; return items; }
      for (;;) {
        items.push(value(depth + 1));
        space();
        const next = source[i++];
        if (next === "]") return items;
        if (next !== ",") return stop(CODE);
      }
    }
    if (c === '"') return string();
    for (const [word, literal] of [["true", true], ["false", false], ["null", null]] as const) {
      if (source.startsWith(word, i)) { i += word.length; return literal; }
    }
    JSON_NUMBER.lastIndex = i;
    const number = JSON_NUMBER.exec(source);
    if (!number) return stop(CODE);
    i += number[0].length;
    return Number(number[0]);
  };
  if (source.startsWith("\ufeff")) return stop(CODE);
  const document = value(0);
  space();
  return i === source.length ? document : stop(CODE);
}

/**
 * The backend blocks of a `.tf.json` file. Only the one shape whose meaning is certain is read: an object at the root, and
 * under its `terraform` property an object (not an array of blocks, not `null`) holding only `TERRAFORM_ITEMS` (and `//`,
 * which HCL ignores as a comment), whose `backend` is an object of backend types, each an object of settings. Any other
 * shape at those places is refused.
 */
function blocksOfJson(source: string): Found[] {
  const document = parseJson(source);
  if (!(document instanceof Map)) return stop(CODE);
  const terraform = document.get("terraform");
  if (terraform === undefined) return [];
  if (!(terraform instanceof Map)) return stop(CODE);
  const found: Found[] = [];
  for (const [item, value] of terraform) {
    if (item === "//") continue;
    if (!TERRAFORM_ITEMS.has(item)) return stop(CODE);
    if (item !== "backend") continue;
    if (!(value instanceof Map)) return stop(CODE);
    for (const [type, settings] of value) {
      if (!(settings instanceof Map)) return stop(CODE);
      const values = new Map<string, Literal>();
      // JSON syntax carries templates in strings and references as `${...}` strings too, so they are judged the same way.
      for (const [name, setting] of settings) {
        values.set(name, typeof setting === "boolean" ? setting : typeof setting === "string" ? literalOf([{ kind: "str", text: setting }]) : EXPRESSION);
      }
      found.push({ type, keys: [...settings.keys()], values });
    }
  }
  return found;
}

/**
 * Throws BACKEND_BLOCK_NOT_IN_CONTRACT unless every backend block in the root module's files is the rule's type with allowed
 * attributes only, each pinned attribute it sets being the rule's literal for `backend` (the contract's backend string).
 */
export function assertBackendBlock(directory: string, rule: BackendBlockRule, backend: string): void {
  const literals = Object.entries(rule.literals?.(backend) ?? {});
  for (const name of readdirSync(directory).filter((n) => /\.tf(\.json)?$/.test(n))) {
    const file = join(directory, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) stop(CODE);
    const json = name.endsWith(".json");
    let source: string;
    // Invalid UTF-8 is refused (both HCL parsers reject it). In native syntax a leading byte order mark is dropped, as hclsyntax
    // drops it; in JSON it is kept, and refused (`parseJson`).
    try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: json }).decode(readFileSync(file)); } catch { return stop(CODE); }
    const blocks = json ? blocksOfJson(source) : blocksOf(tokenize(source));
    for (const block of blocks) {
      if (block.type !== rule.type || block.keys.some((key) => !rule.attributes.includes(key))) return stop(CODE);
      if (literals.some(([key, want]) => block.values.has(key) && block.values.get(key) !== want)) stop(CODE);
    }
  }
}
