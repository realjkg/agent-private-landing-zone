import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, resolve, sep } from "node:path";

import { PHASE_E_SCENARIOS } from "../qualification/phase-e.js";
import { sanitizeDiagnosticText } from "../observability/redaction.js";
import { probeLocalModels, type ModelAvailability } from "./model-availability.js";

export type OperatorMode = "matrix-offline" | "matrix-live" | "aws-review" | "chaos";
export type OperatorJob = {
  mode: OperatorMode;
  script: string;
  args: string[];
  title: string;
  evidenceBasis: string;
  /** The workflow prints a "Recovery verification: <status>" line. */
  reportsRecoveryVerification?: boolean;
};
export type RecoveryVerificationStatus = "VERIFIED" | "PARTIAL" | "BLOCKED" | "NOT_REPORTED";
export type JobState = {
  status: "IDLE" | "RUNNING" | "PASS" | "BLOCKED";
  title: string;
  evidenceBasis: string;
  output: string;
  /**
   * Resilience runs only: the run's own recovery verification result. A
   * resilience PASS means every applicable simulated fault was contained; it
   * never means recovery was verified, so the console reports both.
   */
  recoveryVerification?: RecoveryVerificationStatus;
};

/** Read the workflow's literal recovery verification line; absent means NOT_REPORTED. */
export function readRecoveryVerification(output: string): RecoveryVerificationStatus {
  const match = /^Recovery verification: (VERIFIED|PARTIAL|BLOCKED)$/m.exec(output);
  return match ? (match[1] as RecoveryVerificationStatus) : "NOT_REPORTED";
}

const modes = new Set<OperatorMode>(["matrix-offline", "matrix-live", "aws-review", "chaos"]);
const supported = new Set(PHASE_E_SCENARIOS.map((scenario) => scenario.id));
function assertAllowed(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
export function chooseOperatorJob(modeValue: string, scenarioValue: string): OperatorJob {
  assertAllowed(modes.has(modeValue as OperatorMode), "UNSUPPORTED_WORKFLOW");
  const mode = modeValue as OperatorMode;
  if (mode === "chaos") {
    assertAllowed(!scenarioValue || scenarioValue === "all", "SCENARIO_NOT_APPLICABLE");
    return { mode, script: "cli/chaos-pillars.js", args: [],
      title: "Chaos and Well-Architected pillars",
      evidenceBasis: "SYNTHETIC FAULT INJECTION — no real restore or cloud mutation",
      reportsRecoveryVerification: true };
  }
  if (mode === "aws-review") {
    assertAllowed(!scenarioValue || scenarioValue === "all", "SCENARIO_NOT_APPLICABLE");
    return { mode, script: "cli/qualify-aws-terraform-agent.js",
      args: ["--live-models"], title: "AWS brownfield Terraform private-agent review",
      evidenceBasis: "REAL LOCAL QWEN/MISTRAL — SYNTHETIC AWS INVENTORY — NO TERRAFORM PLAN" };
  }
  assertAllowed(!scenarioValue || scenarioValue === "all" || supported.has(scenarioValue),
    "UNSUPPORTED_SCENARIO");
  const args = [mode === "matrix-live" ? "--live-models" : "--offline-fixture"];
  if (scenarioValue && scenarioValue !== "all") args.push("--scenario", scenarioValue);
  return { mode, script: "cli/private-agent-matrix.js", args,
    title: "ALZ eight-adapter scenario matrix",
    evidenceBasis: mode === "matrix-live"
      ? "REAL LOCAL QWEN/MISTRAL REASONING — SYNTHETIC IaC FIXTURE PREVIEWS"
      : "DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD" };
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

const minimumEnv = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const names = ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR",
    "OLLAMA_BASE_URL", "ROUTER_MODEL", "PRIMARY_MODEL",
    "VALIDATOR_MODEL", "DISAGREEMENT_THRESHOLD", "AGENT_SKIP_LOCAL_MODEL"];
  const result: NodeJS.ProcessEnv = {};
  for (const name of names) if (source[name] !== undefined) result[name] = source[name];
  return result;
};
export async function runOperatorJob(job: OperatorJob, root: string): Promise<string> {
  const script = resolve(root, "dist", job.script);
  assertAllowed(existsSync(script), "WORKSPACE_NEEDS_BUILD");
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
}): { server: Server; getState: () => JobState } {
  const token = randomBytes(24).toString("hex");
  const runner = options.runner ?? runOperatorJob;
  const modelProbe = options.modelProbe ?? (() => probeLocalModels());
  const uiRoot = resolve(options.root, "dist", "operator-ui", "app");
  let state: JobState = {
    status: "IDLE", title: "No workflow",
    evidenceBasis: "NOT_RUN", output: "No scenario executed yet.",
  };
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
    if (state.status === "RUNNING") {
      send(409, "application/json", '{"error":"WORKFLOW_ALREADY_RUNNING"}');return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
      if (body.length > 2048) {
        send(413, "application/json", '{"error":"REQUEST_TOO_LARGE"}');return;
      }
    }
    const form = new URLSearchParams(body);
    if (form.get("token") !== token) {
      send(403, "application/json", '{"error":"CSRF_TOKEN_REQUIRED"}');return;
    }
    let job: OperatorJob;
    try {
      job = chooseOperatorJob(form.get("mode") ?? "", form.get("scenario") ?? "");
    } catch (error) {
      send(400, "application/json", JSON.stringify({
        error: error instanceof Error ? error.message : "INVALID_WORKFLOW",
      }));return;
    }
    state = { status: "RUNNING", title: job.title,
      evidenceBasis: job.evidenceBasis, output: "Preparing governed workflow..." };
    send(202, "application/json", '{"status":"STARTED"}');
    const recovery = (text: string) => job.reportsRecoveryVerification
      ? { recoveryVerification: readRecoveryVerification(text) } : {};
    void runner(job, options.root).then((output) => {
      state = { ...state, status: "PASS", ...recovery(output),
        output: sanitizeDiagnosticText(output.slice(-15000), 15000) };
    }).catch((error) => {
      // Emit class/status only; no raw secrets, model transcripts, or cloud credentials.
      const message = error instanceof Error ? error.message : "UNKNOWN_FAILURE";
      state = { ...state, status: "BLOCKED", ...recovery(message),
        output: sanitizeDiagnosticText(message.slice(0, 15000), 15000) };
    });
  });
  return { server, getState: () => ({ ...state }) };
}
