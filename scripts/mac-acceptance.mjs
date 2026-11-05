#!/usr/bin/env node
/**
 * The JSON half of scripts/mac-acceptance.sh (docs/mac-acceptance-runner.md): small, offline file operations the shell cannot
 * do portably on Apple's bash 3.2. It reads the files the product wrote (the preparation record, a terminal transcript, the
 * saved cost status, the observation summary) and writes only under the run folder the script names, owner-only.
 *
 * What it never does: run `./alz`, call a cloud, read a key or a token file, answer a prompt, or decide a product gate. The cost
 * configuration is judged by the product's own validator and the cost status is redacted by the product's own redaction, both
 * loaded from the built `dist/` (the same modules `./alz cost status` runs).
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The modules of the built product this helper loads, relative to the checkout (they come from src/cost/local.ts and src/cost/status.ts). */
export const DIST_MODULES = {
  local: "dist/cost/local.js",
  status: "dist/cost/status.js",
};

// --- text -------------------------------------------------------------------------------------------------

/** A terminal transcript as plain text: no escape sequences, carriage returns, backspaces or end-of-input marks. */
export function plainText(raw) {
  return String(raw)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[()][A-Za-z0-9]/g, "")
    .replace(/\u001b[=>]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\^D\u0008\u0008/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    // A terminal echoes control input in caret notation (^@, ^D, ^C); at the start of a line it is never the product's output.
    .replace(/^(?:\^[@A-Z[\\\]^_?])+/gm, "");
}

/** Every top-level pretty-printed JSON object in a transcript (a line "{" through a line "}"), parsed, in order. */
export function jsonObjects(text) {
  const lines = plainText(text).split("\n");
  const found = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start].trimEnd() !== "{") continue;
    for (let end = start + 1; end < lines.length; end += 1) {
      if (lines[end].trimEnd() !== "}") continue;
      try {
        const value = JSON.parse(lines.slice(start, end + 1).join("\n"));
        if (value && typeof value === "object" && !Array.isArray(value)) { found.push(value); start = end; }
      } catch { /* not this block */ }
      break;
    }
  }
  return found;
}

/** `./alz apply status --environment DEV`: whether its JSON says PILOT_ENABLED with DEV authorized for APPLY. */
export function pilotEnabled(text, environment = "DEV") {
  const report = jsonObjects(text).reverse().find((o) => typeof o.act === "string");
  if (!report) return { ok: false, reason: "no status report was printed" };
  if (report.act !== "PILOT_ENABLED") return { ok: false, reason: "act is " + report.act };
  const entries = Array.isArray(report.authorized) ? report.authorized : [];
  const entry = entries.find((e) => e && e.environment === environment);
  if (!entry) return { ok: false, reason: environment + " is not in authorized" };
  if (!Array.isArray(entry.operations) || !entry.operations.includes("APPLY")) return { ok: false, reason: environment + " does not authorize APPLY" };
  return { ok: true, operations: entry.operations };
}

/** The path `./alz apply prepare` printed after "record", read from its transcript. */
export function preparationRecordPath(text) {
  const match = /^ {2}record +(\S.*?)\s*$/m.exec(plainText(text));
  return match ? match[1] : undefined;
}

/** What a later step needs from a preparation record (`writePreparation` in src/apply/prepare.ts). */
export function preparationValues(record) {
  const unit = record && record.unit;
  if (!unit || typeof unit.unitId !== "string" || !unit.tags || typeof unit.tags !== "object") throw new Error("PREPARATION_RECORD_UNREADABLE");
  for (const key of ["requestFile", "applyRequestFile", "manifestFile", "projectRoot"]) {
    if (typeof record[key] !== "string" || record[key] === "") throw new Error("PREPARATION_RECORD_UNREADABLE");
  }
  return {
    REQUEST: record.requestFile, APPLY_REQUEST: record.applyRequestFile, MANIFEST: record.manifestFile,
    PROJECT: record.projectRoot, UNIT_ID: unit.unitId, UNIT_TAGS: JSON.stringify(unit.tags),
  };
}

/** The seal's printed result (`sealCommand` in src/cli/apply.ts). */
export function sealValues(text) {
  const sealed = jsonObjects(text).reverse().find((o) => typeof o.sealedPlanPath === "string" && typeof o.artifactSha256 === "string");
  if (!sealed) return undefined;
  return { SEALED: sealed.sealedPlanPath, REVIEW_BUNDLE: sealed.reviewBundlePath, ARTIFACT: sealed.artifactSha256 };
}

/** The signed approval `./alz apply approve` printed for this artifact, or undefined. */
export function approvalOf(text, artifact) {
  return jsonObjects(text).reverse().find((o) => o.statement && typeof o.statement === "object" && o.statement.artifactSha256 === artifact &&
    typeof o.signatureBase64 === "string");
}

// --- redaction --------------------------------------------------------------------------------------------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** The kinds of text never allowed in a bundle. Each is named, never echoed, when found. */
export const SECRET_PATTERNS = [
  ["PRIVATE_KEY", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/],
  ["AWS_ACCESS_KEY_ID", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["AWS_SECRET", /(?:aws_secret_access_key|SecretAccessKey|aws_session_token|SessionToken|x-amz-security-token)["'\s:=]+(?!<REDACTED>)[A-Za-z0-9/+=]{16,}/i],
  ["BEARER", /\bBearer\s+(?!<REDACTED>)[A-Za-z0-9._~+/-]{16,}/],
  ["UNMASKED_EMAIL", /(?<![A-Za-z0-9._%+-])(?!.\*\*\*@)[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
];

/**
 * Text safe to keep in a bundle: keys, tokens and secrets removed, every email masked as the product masks a recipient
 * (`redactAddress`: first character, ***, the domain), the account id replaced unless the owner chose to keep it, and each
 * named literal (the state bucket, key file paths) replaced by its label.
 */
export function redactText(text, { account, keepAccount = false, masks = [], maskEmail = defaultMaskEmail } = {}) {
  let out = plainText(text)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "<REDACTED PRIVATE KEY>")
    .replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, "<REDACTED PEM>")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "<REDACTED TOKEN>")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<REDACTED KEY ID>")
    .replace(/((?:aws_secret_access_key|SecretAccessKey|aws_session_token|SessionToken|x-amz-security-token)["'\s:=]+)[A-Za-z0-9/+=]{16,}/gi, "$1<REDACTED>")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}/g, "$1<REDACTED>")
    .replace(EMAIL, (address) => maskEmail(address));
  // Longer literals first, so a path inside another (the checkout under the home folder) keeps its more specific label.
  for (const [literal, label] of [...masks].sort((a, b) => String(b[0]).length - String(a[0]).length)) if (literal) out = out.split(literal).join(label);
  out = out.replace(/(\/(?:Users|home)\/)[^/\s"'<>]+/g, "$1<USER>");
  if (!keepAccount) {
    if (account) out = out.split(account).join("<ACCOUNT>");
    out = out.replace(/(arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:)[0-9]{12}(?=:)/g, "$1<ACCOUNT>");
  }
  return out;
}

const defaultMaskEmail = (address) => {
  const at = address.lastIndexOf("@");
  return at <= 0 ? "***" : address[0] + "***" + address.slice(at);
};

/** A bare 12-digit number: an account id the masking missed (review N4). Checked unless the owner chose to keep the account. */
export const ACCOUNT_LIKE = /(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/;
/** A home folder with its user name (review N6): /Users/<name>/ or /home/<name>/, other than the label the redaction writes. */
export const USER_PATH = /\/(?:Users|home)\/(?!<USER>)[^/\s"'<>]+/;

/** The named kinds of secret-looking text in a string, or an empty list. With `keepAccount`, a 12-digit number is allowed. */
export function secretKinds(text, { keepAccount = false } = {}) {
  const kinds = SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
  if (!keepAccount && ACCOUNT_LIKE.test(text)) kinds.push("ACCOUNT_ID");
  if (USER_PATH.test(text)) kinds.push("USER_PATH");
  return kinds;
}

/** Where in a folder secret-looking text is: each file, 1-based line number and kind. The matched text is never returned. */
export function secretLines(dir, options = {}) {
  const found = [];
  for (const file of filesUnder(dir)) {
    readFileSync(join(dir, file), "utf8").split("\n").forEach((text, index) => {
      for (const kind of secretKinds(text, options)) found.push({ file, line: index + 1, kind });
    });
  }
  return found;
}

// --- the acceptance report -----------------------------------------------------------------------------

export const ITEM_STATES = ["OBSERVED", "WAITING", "UNKNOWN", "NOT_APPLICABLE", "NEEDS_OWNER_CHECK"];

const label = (value) => !value || typeof value !== "object" ? "UNKNOWN" : value.label === "UNKNOWN" ? "UNKNOWN (" + value.reason + ")" : value.label;
const shown = (value) => !value || typeof value !== "object" ? "UNKNOWN" : value.label === "UNKNOWN" ? "UNKNOWN (" + value.reason + ")"
  : JSON.stringify(value.value) + (value.label === "ESTIMATE" ? " [ESTIMATE: " + value.basis + "]" : " [" + value.label + "]");

/**
 * Items 1 to 8 of the owner's minimum acceptance (docs/act-aws-terraform-execution-brief.md, "Minimum acceptance"), each
 * mapped from what this run actually read: the redacted cost status, the seal and the refused example. A missing input is
 * UNKNOWN, never a pass. Item 2 is always the owner's check, and item 7 does not apply to this run.
 */
export function acceptanceItems({ cost, seal, refused }) {
  const items = [];
  const add = (item, title, state, evidence) => items.push({ item, title, state, evidence });
  if (!cost) {
    add(1, "Deployed budget with the intended amount, filters and recipients", "UNKNOWN", "No saved cost status from this run (./alz cost status did not complete).");
  } else {
    const b = cost.budget;
    const subscribers = b.notifications && b.notifications.label === "OBSERVED"
      ? b.notifications.value.flatMap((n) => (n.subscribers && n.subscribers.label === "OBSERVED" ? n.subscribers.value : [])) : [];
    const viaTopic = subscribers.some((s) => s.type === "SNS");
    const facts = "budget.state " + b.state + "; limit " + shown(b.limit) + "; period " + shown(b.period) + "; filters " + shown(b.filters) +
      "; subscribers " + (subscribers.map((s) => s.type + " " + s.address).join(", ") || "none observed") + ".";
    if (b.state !== "PRESENT") add(1, "Deployed budget with the intended amount, filters and recipients", "UNKNOWN", facts + " The budget was not observed as PRESENT.");
    else add(1, "Deployed budget with the intended amount, filters and recipients", viaTopic ? "NEEDS_OWNER_CHECK" : "OBSERVED",
      facts + " Owner check: compare limit, period and filters with `budget` in config/cost.json." +
      (viaTopic ? " The budget's subscriber is the alert topic (SNS_TOPIC route): the email recipients are confirmed in the SNS console, not by the product." : ""));
  }
  add(2, "Confirmed notification subscriptions and a safe test of the notification route", "NEEDS_OWNER_CHECK",
    "Not read by the product: subscription confirmation is always UNKNOWN (NOT_REPORTED_BY_AWS for email, NOT_READ for SNS)." +
    (cost ? " hasActualAlert " + shown(cost.budget.hasActualAlert) + ", hasForecastAlert " + shown(cost.budget.hasForecastAlert) + "." : "") +
    " Confirm the subscriptions in the SNS console and make a safe test publish yourself.");
  if (!cost) add(3, "Required tags present on supported deployed resources", "UNKNOWN", "No saved cost status from this run.");
  else {
    const t = cost.tags;
    const missing = t.resources && t.resources.label === "OBSERVED" ? t.resources.value.filter((r) => r.missing.length > 0).length : 0;
    const count = t.resources && t.resources.label === "OBSERVED" ? t.resources.value.length : 0;
    add(3, "Required tags present on supported deployed resources", t.state === "ALL_PRESENT" ? "OBSERVED" : "UNKNOWN",
      "tags.state " + t.state + "; required " + JSON.stringify(t.required) + "; " + count + " unit-tagged resources listed, " + missing + " missing a required tag; coverage " + t.coverage +
      (t.state === "NO_RESOURCES_FOUND" ? ". NO_RESOURCES_FOUND is not a pass." : "."));
  }
  if (!cost) add(4, "Cost-allocation tag activation status reported", "UNKNOWN", "No saved cost status from this run.");
  else {
    const c = cost.costAllocationTags;
    const keys = c.tags.map((k) => k.key + " " + label(k.status)).join(", ") || "none";
    const notYet = c.state === "UNKNOWN" && c.tags.some((k) => k.status && k.status.reason === "TAG_KEY_NOT_YET_IN_BILLING");
    add(4, "Cost-allocation tag activation status reported", c.state === "UNKNOWN" ? (notYet ? "WAITING" : "UNKNOWN") : "OBSERVED",
      "costAllocationTags.state " + c.state + " (" + keys + ")." + (c.state === "INACTIVE" ? " INACTIVE is expected while activation is off; it drives overall to ATTENTION." : ""));
  }
  if (!cost) add(5, "Valid export configuration and first delivery, or an explicit waiting state", "UNKNOWN", "No saved cost status from this run.");
  else {
    const e = cost.export;
    const configOk = e.configValid && e.configValid.label === "OBSERVED" && e.configValid.value === true;
    const state = e.state === "DELIVERED" ? "OBSERVED" : e.state === "WAITING" && configOk ? "WAITING" : "UNKNOWN";
    add(5, "Valid export configuration and first delivery, or an explicit waiting state", state,
      "export.state " + e.state + "; configValid " + shown(e.configValid) + (e.configProblems.length ? " (problems " + e.configProblems.join(", ") + ")" : "") +
      "; health " + shown(e.health) + "; lastDelivery " + shown(e.lastDelivery) + "; freshness.state " + cost.freshness.state + "." +
      (state === "UNKNOWN" ? " Passes only as DELIVERED, or WAITING with configValid observed true." : ""));
  }
  const allowed = seal && seal.ok;
  const refusedOk = refused && refused.code === "RESOURCE_NOT_IN_LIMITS";
  add(6, "Provisioning limits tested against allowed and refused examples",
    !allowed ? "UNKNOWN" : refusedOk ? "OBSERVED" : "NEEDS_OWNER_CHECK",
    (allowed ? "Allowed: the cost project's seal succeeded under the limits contract (" + seal.changes + " planned changes)." : "Allowed: the cost project's seal did not complete in this run.") + " " +
    (!refused ? "Refused: the refused example was not run (opt in with --refused-example)."
      : refusedOk ? "Refused: the canary copy's seal stopped with RESOURCE_NOT_IN_LIMITS, exit " + refused.exit + "."
        : "Refused: the canary copy's seal ended with exit " + refused.exit + (refused.code ? " and " + refused.code : "") + ", not RESOURCE_NOT_IN_LIMITS; an earlier gate may have refused first."));
  add(7, "If analytics is selected, ingestion and dashboard refresh with timestamps", "NOT_APPLICABLE",
    "Analytics is phase 2 and not part of this run." + (cost ? " analyticsIngestion " + label(cost.freshness.analyticsIngestion) + ", dashboardRefresh " + label(cost.freshness.dashboardRefresh) + "." : ""));
  if (!cost) add(8, "Clear separation between observed billing, estimates and unknown values", "UNKNOWN", "No saved cost status from this run.");
  else {
    const b = cost.budget;
    const overalls = ["OBSERVED_COMPLETE", "WAITING", "STALE", "ATTENTION", "INCOMPLETE"];
    const separated = overalls.includes(cost.overall) && b.hardSpendCap === false && b.forecastedSpend && ["ESTIMATE", "UNKNOWN"].includes(b.forecastedSpend.label) &&
      b.actualSpend && ["OBSERVED", "UNKNOWN"].includes(b.actualSpend.label);
    add(8, "Clear separation between observed billing, estimates and unknown values", separated ? "OBSERVED" : "UNKNOWN",
      "overall " + cost.overall + "; actualSpend " + label(b.actualSpend) + "; forecastedSpend " + label(b.forecastedSpend) + "; spendCalculatedAt " + label(b.spendCalculatedAt) +
      "; billingPeriod " + label(cost.freshness.billingPeriod) + "; hardSpendCap " + b.hardSpendCap + ". Labels recorded as read, none upgraded.");
  }
  return items;
}

/** Text safe in one Markdown table cell: backslashes first, then the column bars, are escaped; line breaks become spaces. */
export const cell = (text) => String(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

/** The report's text. Everything in it is already redacted by the caller. */
export function reportText({ runId, host, commit, startedAt, finishedAt, steps, items, observation, overall, accountShown }) {
  const lines = [
    "# Acceptance evidence: AWS cost baseline, first supervised DEV run",
    "",
    "**LIVE evidence collected by the owner, on the owner's own host, with `scripts/mac-acceptance.sh`.** It is not CI evidence and",
    "not agent-collected. It does not by itself certify acceptance: the owner reviews it and records acceptance separately.",
    "",
    "| Field | Value |", "| --- | --- |",
    "| Run | " + runId + " |",
    "| Host | " + host + " |",
    "| Candidate commit | " + commit + " |",
    "| Started | " + startedAt + " |",
    "| Bundle written | " + finishedAt + " |",
    "| Disposition | **RETAIN** (no cleanup was proposed or run) |",
    "| Account id | " + (accountShown ? "included (owner opted in)" : "masked as `<ACCOUNT>`") + " |",
    "",
    "## Acceptance items 1 to 8",
    "",
    "States: OBSERVED (read in this run), WAITING (an explicit waiting state AWS reported), UNKNOWN (not read or not as required),",
    "NOT_APPLICABLE, NEEDS_OWNER_CHECK (the product does not read it; the owner confirms it).",
    "",
    "| # | Item | State | Evidence |", "| --- | --- | --- | --- |",
    ...items.map((i) => "| " + i.item + " | " + i.title + " | " + i.state + " | " + cell(i.evidence) + " |"),
    "",
    "## Observation",
    "",
    observation ? "`./alz apply observe`: verdict " + observation.verdict + ", inventory " + observation.inventory + ", observed at " + observation.observedAt +
      ". For this payload a VERIFIED verdict is not expected: the mapped types (bucket, topic, export) should be VERIFIED and every unmapped type UNVERIFIABLE (see the transcript)."
      : "`./alz apply observe` did not complete in this run.",
    "",
    "Cost status overall: " + (overall ?? "not read") + ". On day one INCOMPLETE is expected, not WAITING.",
    "",
    "## Steps",
    "",
    "| Step | Exit | Started | Finished | Output SHA-256 |", "| --- | --- | --- | --- | --- |",
    ...steps.map((s) => "| " + s.name + " | " + (s.exit ?? "") + " | " + (s.started ?? "") + " | " + (s.finished ?? "") + " | " + (s.digest ?? "") + " |"),
    "",
    "Digests are of the unredacted output on the host. Terminal steps record one transcript (standard output and error together,",
    "because the product requires a terminal); captured steps record standard output and error separately.",
    "",
    "## Retention",
    "",
    "The default disposition is RETAIN (owner decision record 6646346513). The run's resources stay in place: billing history is",
    "not destroyed to complete acceptance. Teardown needs a separate, explicit disposition and the brief's cleanup step, run by",
    "a person; this script never proposes or runs one.",
    "",
  ];
  return lines.join("\n");
}

// --- files ----------------------------------------------------------------------------------------------

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function privateWrite(path, text) {
  const temp = path + ".partial-" + process.pid;
  writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }

/** Every regular file under a folder, relative, sorted; a link anywhere is refused. */
export function filesUnder(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error("LINK_IN_BUNDLE " + relative(base, full));
    if (stat.isDirectory()) out.push(...filesUnder(full, base));
    else if (stat.isFile()) out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}

/** Reads `key=value` lines (the script's own state files). */
export function readKeyValues(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
}

async function productModule(root, which) {
  return import(pathToFileURL(resolve(root, DIST_MODULES[which])).href);
}

// --- command line ---------------------------------------------------------------------------------------

const say = (line) => process.stdout.write(line + "\n");
const COMMANDS = {
  /** contract ROOT: the committed contract's DEV target, as key=value lines (no secret is in the contract). */
  contract([root]) {
    const contract = readJson(join(root, "config/act-pilot-contract.json"));
    const dev = contract.targets && contract.targets.DEV;
    if (!dev) throw new Error("CONTRACT_HAS_NO_DEV_TARGET");
    const backend = typeof dev.backend === "string" ? dev.backend : "";
    say("ACCOUNT=" + (dev.accountId ?? ""));
    say("REGION=" + (dev.region ?? ""));
    say("STATE_BUCKET=" + (backend.includes("/") ? backend.slice(0, backend.indexOf("/")) : backend));
    say("KILL_SWITCH=" + (contract.killSwitchPath ?? ""));
    say("HAS_LIMITS=" + (dev.limits ? "yes" : "no"));
    say("PROVIDER=" + (contract.provider ?? "") + "/" + (contract.engine ?? ""));
    say("APPROVER_IDS=" + (Array.isArray(contract.approvers) ? contract.approvers.map((a) => a.id).join(",") : ""));
  },
  /** node-major ROOT: the Node major the repository pins (config/tool-pins.json). */
  "node-major"([root]) { say(String(readJson(join(root, "config/tool-pins.json")).node.major)); },
  /** cost-config ROOT: the product's own validator on config/cost.json; names problem paths and codes, never values. */
  async "cost-config"([root]) {
    const { readLocalCostConfig } = await productModule(root, "local");
    const result = readLocalCostConfig(join(root, "config/cost.json"));
    if (result.state === "OK") { say("OK"); return 0; }
    if (result.state === "NONE") { say("NONE"); return 2; }
    say("INVALID " + result.issues.map((i) => i.path + " " + i.code).join(", "));
    return 2;
  },
  /** pilot-enabled TRANSCRIPT */
  "pilot-enabled"([file]) {
    const result = pilotEnabled(readFileSync(file, "utf8"));
    say(result.ok ? "PILOT_ENABLED " + result.operations.join(",") : "NOT_ENABLED " + result.reason);
    return result.ok ? 0 : 2;
  },
  /** prepared TRANSCRIPT: key=value lines from the preparation record the transcript names. */
  prepared([file]) {
    const path = preparationRecordPath(readFileSync(file, "utf8"));
    if (!path) throw new Error("PREPARATION_RECORD_NOT_PRINTED");
    for (const [key, value] of Object.entries({ RECORD: path, ...preparationValues(readJson(path)) })) say(key + "=" + value);
  },
  /** fill-tags PROJECT UNIT_TAGS_JSON: copies the example tfvars if needed, then sets unit_tags. Prints what it wrote. */
  "fill-tags"([project, tagsJson]) {
    const tags = JSON.parse(tagsJson);
    const target = join(project, "terraform.tfvars.json");
    const example = join(project, "terraform.tfvars.example.json");
    const current = existsSync(target) ? readJson(target) : readJson(example);
    current.unit_tags = tags;
    privateWrite(target, JSON.stringify(current, null, 2) + "\n");
    say("unit_tags in " + target + ": " + Object.entries(tags).map(([k, v]) => k + "=" + v).join(", "));
  },
  /** sealed TRANSCRIPT */
  sealed([file]) {
    const values = sealValues(readFileSync(file, "utf8"));
    if (!values) throw new Error("SEAL_RESULT_NOT_PRINTED");
    for (const [key, value] of Object.entries(values)) say(key + "=" + value);
  },
  /** approval TRANSCRIPT ARTIFACT OUT: saves the signed approval the product printed (no secret) for `apply --approval`. */
  approval([file, artifact, out]) {
    const approval = approvalOf(readFileSync(file, "utf8"), artifact);
    if (!approval) { say("NOT_FOUND"); return 2; }
    privateWrite(out, JSON.stringify(approval, null, 2) + "\n");
    say("SAVED " + out);
    return 0;
  },
  /** refusal TRANSCRIPT: the refusal code a blocked command printed, if any. */
  refusal([file]) {
    const text = plainText(readFileSync(file, "utf8"));
    const code = /RESOURCE_NOT_IN_LIMITS/.test(text) ? "RESOURCE_NOT_IN_LIMITS" : (/\b(?:BLOCKED|REFUSED)[: ]+([A-Z][A-Z0-9_]{3,})/.exec(text) ?? [])[1];
    say(code ?? "");
  },
  /** sha256 FILE */
  sha256([file]) { say(sha256(readFileSync(file))); },
  /** redact ROOT IN OUT ACCOUNT KEEP_ACCOUNT(yes|no) [LITERAL LABEL]... */
  async redact([root, input, output, account, keep, ...pairs]) {
    const masks = [];
    for (let i = 0; i + 1 < pairs.length; i += 2) masks.push([pairs[i], pairs[i + 1]]);
    const maskEmail = await emailMasker(root);
    privateWrite(output, redactText(readFileSync(input, "utf8"), { account, keepAccount: keep === "yes", masks, maskEmail }));
  },
  /** cost ROOT OUT ACCOUNT KEEP_ACCOUNT [LITERAL LABEL]...: the saved cost status, redacted by the product, then masked. */
  async cost([root, output, account, keep, ...pairs]) {
    const { readCostSnapshot } = await productModule(root, "local");
    const { redactCostStatus } = await productModule(root, "status");
    const snapshot = readCostSnapshot(join(root, ".runs/cost/status.json"));
    if (snapshot.state !== "OK") { say(snapshot.state); return 2; }
    const masks = [];
    for (let i = 0; i + 1 < pairs.length; i += 2) masks.push([pairs[i], pairs[i + 1]]);
    const maskEmail = await emailMasker(root);
    privateWrite(output, redactText(JSON.stringify(redactCostStatus(snapshot.status), null, 2) + "\n", { account, keepAccount: keep === "yes", masks, maskEmail }));
    say("OK");
    return 0;
  },
  /** review BUNDLE OUT ACCOUNT KEEP_ACCOUNT [LITERAL LABEL]...: the review bundle's change list, unit and provenance (no target, no signature). */
  review([input, output, account, keep, ...pairs]) {
    const masks = [];
    for (let i = 0; i + 1 < pairs.length; i += 2) masks.push([pairs[i], pairs[i + 1]]);
    const b = readJson(input);
    const picked = { artifactSha256: b.artifactSha256, environment: b.environment, sourceCommit: b.sourceCommit, createdAt: b.createdAt, policyVersion: b.policyVersion,
      engineVersion: b.engineVersion, provenance: b.provenance, unit: b.unit, changes: b.changes, changesSha256: b.changesSha256 };
    privateWrite(output, redactText(JSON.stringify(picked, null, 2) + "\n", { account, keepAccount: keep === "yes", masks }));
  },
  /** report RUN_DIR BUNDLE_DIR: acceptance-report.md from the run's step records and the bundle's redacted files. */
  report([runDir, bundleDir]) {
    const values = readKeyValues(join(runDir, "values"));
    const stepsDir = join(runDir, "steps");
    const steps = existsSync(stepsDir) ? readdirSync(stepsDir).filter((n) => n.endsWith(".env")).sort().map((n) => {
      const v = readKeyValues(join(stepsDir, n));
      return { name: n.replace(/\.env$/, ""), exit: v.EXIT, started: v.STARTED, finished: v.FINISHED, digest: v.TRANSCRIPT_SHA256 || [v.STDOUT_SHA256 && "out " + v.STDOUT_SHA256, v.STDERR_SHA256 && "err " + v.STDERR_SHA256].filter(Boolean).join(" ") };
    }) : [];
    const costFile = join(bundleDir, "cost-status.redacted.json");
    const cost = existsSync(costFile) ? readJson(costFile) : undefined;
    const sealStep = readKeyValues(join(stepsDir, "08-seal.env"));
    const reviewFile = join(bundleDir, "review-bundle.json");
    const seal = sealStep.EXIT === "0" ? { ok: true, changes: existsSync(reviewFile) ? (readJson(reviewFile).changes ?? []).length : "unknown" } : undefined;
    const refusedStep = readKeyValues(join(stepsDir, "17-refused-seal.env"));
    const refused = refusedStep.EXIT !== undefined ? { exit: refusedStep.EXIT, code: refusedStep.REFUSAL || undefined } : undefined;
    const observationFile = join(bundleDir, "observation-summary.json");
    const observation = existsSync(observationFile) ? readJson(observationFile) : undefined;
    const items = acceptanceItems({ cost, seal, refused });
    const text = reportText({
      runId: basename(runDir), host: values.HOST ?? "unknown", commit: values.COMMIT ?? "unknown", startedAt: values.STARTED ?? "unknown",
      finishedAt: new Date().toISOString(), steps, items, observation, overall: cost && cost.overall, accountShown: values.KEEP_ACCOUNT === "yes",
    });
    privateWrite(join(bundleDir, "acceptance-report.md"), text);
    say(items.map((i) => "  item " + i.item + "  " + i.state).join("\n"));
  },
  /** scan DIR [KEEP_ACCOUNT]: refuses a bundle holding secret-looking text, an unmasked account id or a user path; names the file, line and kind, never the value. */
  scan([dir, keep]) {
    const found = secretLines(dir, { keepAccount: keep === "yes" }).map((f) => f.file + ":" + f.line + " " + f.kind);
    if (found.length) { for (const line of found) say("SECRET_LIKE " + line); return 2; }
    say("CLEAN");
    return 0;
  },
  /** manifest DIR: MANIFEST.sha256 over every file, in `shasum -a 256 -c` format. */
  manifest([dir]) {
    const lines = filesUnder(dir).filter((f) => f !== "MANIFEST.sha256").map((f) => sha256(readFileSync(join(dir, f))) + "  " + f);
    privateWrite(join(dir, "MANIFEST.sha256"), lines.join("\n") + "\n");
    say(String(lines.length));
  },
  /** mkdir-private DIR: an owner-only folder (0700), refusing a link. */
  "mkdir-private"([dir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new Error("LINK_REFUSED");
    chmodSync(dir, 0o700);
  },
};

/** The product's own email mask (src/cost/status.ts `redactAddress`), or the same rule when the build is not there. */
async function emailMasker(root) {
  try {
    if (root) {
      const { redactAddress } = await productModule(root, "status");
      if (typeof redactAddress === "function") return (address) => redactAddress("EMAIL", address);
    }
  } catch { /* fall back to the same rule */ }
  return defaultMaskEmail;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  const run = COMMANDS[command];
  if (!run) { process.stderr.write("mac-acceptance helper: unknown command\n"); process.exit(1); }
  Promise.resolve().then(() => run(args)).then((code) => { process.exitCode = typeof code === "number" ? code : 0; }, (error) => {
    // Our own codes only; never a stack trace or a file's contents.
    const message = error instanceof Error && /^[A-Z][A-Z0-9_]+(?: .*)?$/.test(error.message) ? error.message : "HELPER_FAILED";
    process.stderr.write("mac-acceptance helper: " + message + "\n");
    process.exitCode = 1;
  });
}
