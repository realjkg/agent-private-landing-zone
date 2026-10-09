import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

import { PHASE_E_SCENARIOS } from "../qualification/phase-e.js";

export type OperatorMode = "matrix-offline" | "matrix-live" | "aws-review" | "chaos";
export type OperatorJob = {
  mode: OperatorMode;
  script: string;
  args: string[];
  title: string;
  evidenceBasis: string;
};
export type JobState = {
  status: "IDLE" | "RUNNING" | "PASS" | "BLOCKED";
  title: string;
  evidenceBasis: string;
  output: string;
};

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
      evidenceBasis: "SYNTHETIC FAULT INJECTION — no real restore or cloud mutation" };
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

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function page(token: string): string {
  const options = PHASE_E_SCENARIOS.map((scenario) =>
    '<option value="' + escapeHtml(scenario.id) + '">' +
    escapeHtml(scenario.id.replaceAll("-", " ")) + "</option>").join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sovereign ALZ — Local Operator</title>
<style>
:root{color-scheme:light;--bg:#f5f5f0;--ink:#172a27;--muted:#52645e;--edge:#d5dfd7;--accent:#285848}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,sans-serif}
main{max-width:930px;margin:0 auto;padding:34px 20px 70px}header{display:flex;justify-content:space-between;align-items:center;gap:20px}
small{color:var(--muted)}h1{font-size:30px;line-height:1.2;letter-spacing:-.03em;margin:12px 0}p{max-width:720px}
.panel{background:white;border:1px solid var(--edge);padding:26px;border-radius:14px;margin-top:22px}
label{font-weight:650;display:block;margin:18px 0 6px}select,button{font:inherit;border-radius:9px;padding:12px 15px}
select{width:100%;border:1px solid #a6b8ab;background:#fff;color:var(--ink)}
button{background:var(--accent);color:#fff;border:0;font-weight:650;cursor:pointer;margin-top:20px}
button:disabled{opacity:.5;cursor:default}
#output{white-space:pre-wrap;overflow-wrap:anywhere;max-height:350px;overflow:auto;background:#f7f9f7;padding:18px;border-radius:8px;font:13px/1.5 ui-monospace,monospace}
.line{border-top:1px solid var(--edge);margin:18px 0}
#state{font-weight:650}.tag{background:#e5ede7;padding:7px 11px;border-radius:40px;font-size:12px}
.footer{color:var(--muted);font-size:13px}
</style></head><body><main>
<header><strong>SOVEREIGN ALZ</strong><span class="tag">LOCAL • PREVIEW ONLY</span></header>
<h1>Private Agent Workspace</h1><p>Explore governed landing-zone assessments, review private-model findings,
and verify safe infrastructure previews. No deployments, cloud changes or automatic approvals.</p>
<section class="panel">
<h2>Choose a workflow</h2>
<form id="run" method="post" action="/run">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<label for="mode">What would you like to do?</label>
<select name="mode" id="mode">
<option value="matrix-offline">Explore all existing landing-zone scenarios (offline)</option>
<option value="matrix-live">Analyze scenarios with private Qwen / Mistral models</option>
<option value="aws-review">Review the AWS brownfield Terraform proposal with private models</option>
<option value="chaos">Check backup, recovery and Well-Architected fault handling</option>
</select>
<label for="scenario">Environment and infrastructure approach</label>
<select name="scenario" id="scenario"><option value="all">All supported scenarios</option>${options}</select>
<p><small>Live-model choices require installed models on this machine. AWS evidence is synthetic.
Terraform plans and infrastructure ACT are not available from this workspace.</small></p>
<button type="submit" id="start">Run selected workflow</button></form>
</section>
<section class="panel"><h2>Execution and evidence</h2>
<p id="state" role="status" aria-live="polite">IDLE</p>
<p id="basis">Choose a workflow to view its evidence classification.</p>
<div class="line"></div><div id="output" aria-live="polite">No scenario executed yet.</div>
</section><p class="footer">Localhost-only session • One run at a time • ACT permanently disabled in this accelerator release.
Offline results cannot qualify live models, live-cloud discovery or a real recovery test.</p>
</main>
<script nonce="${escapeHtml(token)}">
const form=document.querySelector('#run'),mode=document.querySelector('#mode'),scenario=document.querySelector('#scenario');
const state=document.querySelector('#state'),basis=document.querySelector('#basis'),output=document.querySelector('#output'),start=document.querySelector('#start');
function update(){
  const available=mode.value==='matrix-offline'||mode.value==='matrix-live';
  scenario.disabled=!available; if(!available)scenario.value='all';
}
mode.addEventListener('change',update);update();
async function refresh(){
  try {
    const res=await fetch('/state',{cache:'no-store'});if(!res.ok)return;
    const data=await res.json();
    state.textContent=data.status;basis.textContent=data.evidenceBasis;
    output.textContent=data.output||'No output yet.';
    start.disabled=data.status==='RUNNING';
  } catch {state.textContent='Local session unavailable';}
}
form.addEventListener('submit',async (event)=>{
  event.preventDefault();start.disabled=true;
  try {
    const response=await fetch('/run',{method:'POST',body:new URLSearchParams(new FormData(form))});
    if(!response.ok){const item=await response.json();output.textContent=item.error||'Request denied';}
  } catch {output.textContent='Cannot reach local operator';}
  await refresh();
});
setInterval(refresh,1000);refresh();
</script></body></html>`;
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
}): { server: Server; getState: () => JobState } {
  const token = randomBytes(24).toString("hex");
  const runner = options.runner ?? runOperatorJob;
  let state: JobState = {
    status: "IDLE", title: "No workflow",
    evidenceBasis: "NOT_RUN", output: "No scenario executed yet.",
  };
  const server = createServer(async (req, res) => {
    const port = (server.address() && typeof server.address() === "object")
      ? server.address()!.port : 8788;
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
      res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-" + token +
        "'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(page(token));return;
    }
    if (req.method === "GET" && req.url === "/state") {
      send(200, "application/json", JSON.stringify(state));return;
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
    void runner(job, options.root).then((output) => {
      state = { ...state, status: "PASS", output: output.slice(-15000) };
    }).catch((error) => {
      // Emit class/status only; no raw secrets, model transcripts, or cloud credentials.
      const message = error instanceof Error ? error.message : "UNKNOWN_FAILURE";
      state = { ...state, status: "BLOCKED",
        output: message.slice(0, 15000) };
    });
  });
  return { server, getState: () => ({ ...state }) };
}
