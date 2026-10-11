import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createServer, type Server } from "node:http";
import { extname, join, resolve, sep } from "node:path";

import { loadConfig } from "../config.js";
import { sanitizeDiagnosticText } from "../observability/redaction.js";
import { OPERATIONS } from "../operations/registry.js";
import { planOperation, runPlanned } from "../operations/run.js";
import { describeOperation, maxRequestBytes } from "../operations/schema.js";
import type { OperationSpec, OperatorJob } from "../operations/types.js";
import { WORKFLOW_IDS, workflowOperations } from "../operations/workflows.js";
import { isLoopbackModelEndpoint, probeLocalModels, type ModelAvailability } from "./model-availability.js";

export type OperatorMode = (typeof WORKFLOW_IDS)[number];
export type { OperatorJob };
export type RecoveryVerificationStatus = "VERIFIED" | "PARTIAL" | "BLOCKED" | "NOT_REPORTED";
export type JobState = {
  status: "IDLE" | "RUNNING" | "PASS" | "BLOCKED";
  /** Id of the operation that produced this state; absent before any run. */
  operation?: string;
  title: string;
  evidenceBasis: string;
  output: string;
  /**
   * Resilience runs only: the run's own recovery verification result. A
   * resilience PASS means every applicable simulated fault was contained; it
   * never means recovery was verified, so the console reports both.
   */
  recoveryVerification?: RecoveryVerificationStatus;
  /** Blocked runs only, when the cause is a known local setup state. */
  blockReason?: BlockReason;
};

/**
 * Setup states an operator can fix on their own machine. Only these get a
 * plain-language next step in the console; anything else stays the literal
 * diagnostic. Explaining a block never relaxes it.
 */
export type BlockReason = "SOURCE_WORKTREE_DIRTY" | "WORKSPACE_NEEDS_BUILD";

export function readBlockReason(message: string): BlockReason | undefined {
  const match = /\b(SOURCE_WORKTREE_DIRTY|WORKSPACE_NEEDS_BUILD)\b/.exec(message);
  return match ? (match[1] as BlockReason) : undefined;
}

/** Build output the workspace needs: the console UI and every job script. */
export function missingWorkspaceBuild(root: string): string[] {
  const scripts = [...modes].map((mode) => "dist/" + chooseOperatorJob(mode, "all").script);
  const required = ["dist/operator-ui/app/index.html", ...new Set(scripts)];
  return required.filter((path) => !existsSync(resolve(root, path)));
}

/** Read the workflow's literal recovery verification line; absent means NOT_REPORTED. */
export function readRecoveryVerification(output: string): RecoveryVerificationStatus {
  const match = /^Recovery verification: (VERIFIED|PARTIAL|BLOCKED)$/m.exec(output);
  return match ? (match[1] as RecoveryVerificationStatus) : "NOT_REPORTED";
}

const modes = new Set<string>(WORKFLOW_IDS);
function assertAllowed(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
/** The legacy POST /run {mode, scenario} contract, derived from the catalog's workflow entries. */
export function chooseOperatorJob(modeValue: string, scenarioValue: string): OperatorJob {
  assertAllowed(modes.has(modeValue), "UNSUPPORTED_WORKFLOW");
  const spec = workflowOperations.find((item) => item.id === modeValue)!;
  const field = spec.inputs.find((item) => item.name === "scenario");
  const scenario = scenarioValue || "all";
  assertAllowed(field || scenario === "all", "SCENARIO_NOT_APPLICABLE");
  assertAllowed(field?.kind !== "enum" || field.options.includes(scenario), "UNSUPPORTED_SCENARIO");
  const job = spec.job!;
  return { mode: spec.id, script: job.script, args: job.args({ scenario }),
    title: spec.title, evidenceBasis: spec.evidenceBasis,
    ...(job.reportsRecoveryVerification ? { reportsRecoveryVerification: true } : {}) };
}

// --- Console shell (React build output) ----------------------------------
//
// The console front end is built by vite (src/operator-ui/app) and served
// from dist/operator-ui/app as first-party static assets. The server injects
// only the per-session CSRF token into the built shell; everything else the
// browser renders is frozen at build time, so the same page ships to every
// operator and disclosure happens client-side (D1 contract).

const CONSOLE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; " +
  "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

// POST /run body cap: derived from the catalog (maxRequestBytes) so a legal input is never refused here.
const MIN_RUN_BODY = 16 * 1024;

const CONSOLE_CSRF_PLACEHOLDER = "__ALZ_CSRF_TOKEN__";

const CONSOLE_ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};

// First-party asset routes only: a single path segment under assets/ or
// fonts/, no URL decoding, and a resolve + containment check so a crafted
// name can never leave the build output directory.
const CONSOLE_ASSET_ROUTE = /^\/(assets|fonts)\/([A-Za-z0-9._-]+)$/;

async function readConsolePage(uiRoot: string): Promise<string> {
  const shell = await readFile(resolve(uiRoot, "index.html"), "utf8");
  assertAllowed(shell.includes(CONSOLE_CSRF_PLACEHOLDER), "CONSOLE_SHELL_INVALID");
  return shell;
}

async function readConsoleAsset(
  uiRoot: string,
  url: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  const match = CONSOLE_ASSET_ROUTE.exec(url);
  if (!match) return null;
  const directory = resolve(uiRoot, match[1]);
  const filePath = resolve(directory, match[2]);
  if (!filePath.startsWith(directory + sep)) return null;
  const contentType = CONSOLE_ASSET_CONTENT_TYPES[extname(filePath).toLowerCase()];
  if (!contentType || !existsSync(filePath)) return null;
  return { body: await readFile(filePath), contentType };
}

/**
 * The only environment a console job receives. AGENTIC_EVIDENCE_KEY_FILE is a
 * path, not a secret, and is forwarded so evidence-writing jobs use the key
 * the operator chose; AGENTIC_EVIDENCE_KEY (the key itself) never is.
 * AGENTIC_SECURITY_POLICY_MODE names the policy engine and is not a secret.
 */
export const minimumEnv = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const names = ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR",
    "OLLAMA_BASE_URL", "ROUTER_MODEL", "PRIMARY_MODEL",
    "VALIDATOR_MODEL", "DISAGREEMENT_THRESHOLD", "AGENT_SKIP_LOCAL_MODEL",
    "AGENTIC_EVIDENCE_KEY_FILE", "AGENTIC_SECURITY_POLICY_MODE"];
  const result: NodeJS.ProcessEnv = {};
  for (const name of names) if (source[name] !== undefined) result[name] = source[name];
  return result;
};
/**
 * The evidence key a console job would use, or null when none exists. The
 * console never creates a key: on a fresh machine it is created in a terminal
 * (./alz doctor), where the operator can see where it goes.
 */
export function evidenceKeyMissing(source: NodeJS.ProcessEnv = process.env): string | null {
  const path = source.AGENTIC_EVIDENCE_KEY_FILE ??
    join(source.HOME ?? source.USERPROFILE ?? homedir(), ".config", "agentic-landing-zone", "evidence.key");
  return existsSync(path) ? null
    : "EVIDENCE_KEY_MISSING: this operation writes encrypted evidence, but no local evidence key exists, and the console never creates one. " +
      "Run ./alz doctor once in a terminal, or set AGENTIC_EVIDENCE_KEY_FILE to an existing key file, then start the console again.";
}

export async function runOperatorJob(job: OperatorJob, root: string): Promise<string> {
  const script = resolve(root, "dist", job.script);
  assertAllowed(existsSync(script), "WORKSPACE_NEEDS_BUILD");
  const keyProblem = job.writesLocal ? evidenceKeyMissing(process.env) : null;
  if (keyProblem) throw new Error(keyProblem);
  return new Promise((resolveOutput, reject) => {
    const proc = spawn(process.execPath, [script, ...job.args], {
      cwd: root, env: minimumEnv(process.env), shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const accumulate = (chunk: Buffer) => {
      // Never render arbitrary HTML; frontend uses textContent. Keep output bounded.
      output = (output + chunk.toString("utf8")).slice(-15000);
    };
    proc.stdout.on("data", accumulate);proc.stderr.on("data", accumulate);
    const timeout = setTimeout(() => proc.kill("SIGTERM"), 20*60*1000);
    proc.on("error", (error) => {clearTimeout(timeout);reject(error);});
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveOutput(output);
      else reject(new Error("WORKFLOW_BLOCKED_EXIT_" + String(code) + "\n" + output));
    });
  });
}

export function createLocalOperatorServer(options: {
  root: string;
  runner?: (job: OperatorJob, root: string) => Promise<string>;
  modelProbe?: () => Promise<ModelAvailability>;
  /** Test seam: the operation catalog. Production uses the registry. */
  catalog?: readonly OperationSpec[];
}): { server: Server; getState: () => JobState } {
  const token = randomBytes(24).toString("hex");
  const runner = options.runner ?? runOperatorJob;
  const modelProbe = options.modelProbe ?? (() => probeLocalModels());
  const uiRoot = resolve(options.root, "dist", "operator-ui", "app");
  const catalog = options.catalog ?? OPERATIONS;
  const operationsJson = JSON.stringify(catalog.map(describeOperation));
  const maxRunBody = Math.max(MIN_RUN_BODY, maxRequestBytes(catalog));
  let state: JobState = {
    status: "IDLE", title: "No workflow",
    evidenceBasis: "NOT_RUN", output: "No scenario executed yet.",
  };
  const busy = () => state.status === "RUNNING";
  const server = createServer(async (req, res) => {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 8788;
    const expectedHost = "127.0.0.1:" + port;
    const host = req.headers.host ?? "";
    const origin = req.headers.origin;
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    };
    const send = (code: number, type: string, body: string) => {
      res.writeHead(code, { ...headers, "Content-Type": type });res.end(body);
    };
    if (host !== expectedHost || (origin && origin !== "http://" + expectedHost)) {
      send(403, "application/json", '{"error":"LOCAL_HOST_ONLY"}');return;
    }
    if (req.method === "GET" && req.url === "/") {
      let shell: string;
      try {
        shell = await readConsolePage(uiRoot);
      } catch (error) {
        // Missing build output is a fixable setup state, not a crash; anything
        // else (including an invalid shell) is a server-side defect.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          send(503, "application/json",
            '{"error":"CONSOLE_BUILD_MISSING","hint":"npm run build:ui"}');
        } else {
          send(500, "application/json", '{"error":"CONSOLE_SHELL_INVALID"}');
        }
        return;
      }
      res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": CONSOLE_CSP });
      res.end(shell.split(CONSOLE_CSRF_PLACEHOLDER).join(token));
      return;
    }
    if (req.method === "GET" && req.url === "/state") {
      send(200, "application/json", JSON.stringify(state));return;
    }
    if (req.method === "GET" && req.url === "/operations") {
      // Public descriptors only: no script, path or argument builder.
      send(200, "application/json", operationsJson);return;
    }
    if (req.method === "GET" && req.url === "/models") {
      // Advisory, read-only availability for the private-model workflows;
      // it grants nothing and POST /run validation does not consult it.
      let availability: ModelAvailability;
      try {
        availability = await modelProbe();
      } catch {
        send(503, "application/json", '{"error":"MODEL_PROBE_FAILED"}');return;
      }
      send(200, "application/json", JSON.stringify(availability));return;
    }
    if (req.method === "GET") {
      const asset = await readConsoleAsset(uiRoot, req.url ?? "");
      if (asset) {
        res.writeHead(200, { ...headers, "Content-Type": asset.contentType,
          "Content-Length": asset.body.byteLength });
        res.end(asset.body);
        return;
      }
    }
    if (req.method !== "POST" || req.url !== "/run") {
      send(404, "application/json", '{"error":"NOT_FOUND"}');return;
    }
    if (!(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) {
      send(415, "application/json", '{"error":"FORM_ENCODING_REQUIRED"}');return;
    }
    if (busy()) {
      send(409, "application/json", '{"error":"WORKFLOW_ALREADY_RUNNING"}');return;
    }
    let body = "";
    let received = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      received += chunk.length;
      if (received > maxRunBody) {
        send(413, "application/json", '{"error":"REQUEST_TOO_LARGE"}');return;
      }
      body += chunk.toString();
    }
    const form = new URLSearchParams(body);
    // Only an operation request may carry pasted JSON; a legacy one stays small.
    if (!form.has("operation") && body.length > 2048) {
      send(413, "application/json", '{"error":"REQUEST_TOO_LARGE"}');return;
    }
    if (form.get("token") !== token) {
      send(403, "application/json", '{"error":"CSRF_TOKEN_REQUIRED"}');return;
    }
    // Body reading yields, so check the one-worker rule again before claiming it.
    if (busy()) {
      send(409, "application/json", '{"error":"WORKFLOW_ALREADY_RUNNING"}');return;
    }
    let id: string;
    let safety: OperationSpec["safety"] | undefined;
    let title: string;
    let evidenceBasis: string;
    let reportsRecovery: boolean;
    let execute: () => Promise<string>;
    try {
      if (form.has("operation")) {
        assertAllowed(!form.has("mode") && !form.has("scenario"), "AMBIGUOUS_REQUEST");
        const plan = planOperation(form.get("operation") ?? "", form.get("inputs"), catalog);
        ({ id, title, evidenceBasis, safety } = plan.spec);
        reportsRecovery = plan.spec.job?.reportsRecoveryVerification === true;
        execute = () => runPlanned(plan, options.root, runner);
      } else {
        const job = chooseOperatorJob(form.get("mode") ?? "", form.get("scenario") ?? "");
        ({ mode: id, title, evidenceBasis } = job);
        safety = workflowOperations.find((item) => item.id === id)?.safety;
        reportsRecovery = job.reportsRecoveryVerification === true;
        execute = () => runner(job, options.root);
      }
      // LOCAL_MODEL means the private model server on this machine. Nothing else may receive the prompts.
      assertAllowed(safety !== "LOCAL_MODEL" || isLoopbackModelEndpoint(process.env.OLLAMA_BASE_URL ?? loadConfig().ollamaBaseUrl),
        "MODEL_ENDPOINT_NOT_LOOPBACK");
    } catch (error) {
      send(400, "application/json", JSON.stringify({
        error: error instanceof Error ? error.message : "INVALID_WORKFLOW",
      }));return;
    }
    state = { status: "RUNNING", operation: id, title,
      evidenceBasis, output: "Preparing governed workflow..." };
    send(202, "application/json", '{"status":"STARTED"}');
    const recovery = (text: string) => reportsRecovery
      ? { recoveryVerification: readRecoveryVerification(text) } : {};
    void execute().then((output) => {
      state = { ...state, status: "PASS", ...recovery(output),
        output: sanitizeDiagnosticText(output.slice(-15000), 15000) };
    }).catch((error) => {
      // Emit class/status only; no raw secrets, model transcripts, or cloud credentials.
      const message = error instanceof Error ? error.message : "UNKNOWN_FAILURE";
      const blockReason = readBlockReason(message);
      state = { ...state, status: "BLOCKED", ...recovery(message),
        ...(blockReason ? { blockReason } : {}),
        output: sanitizeDiagnosticText(message.slice(0, 15000), 15000) };
    });
  });
  return { server, getState: () => ({ ...state }) };
}
