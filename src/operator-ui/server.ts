import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

import { PHASE_E_SCENARIOS } from "../qualification/phase-e.js";
import { sanitizeDiagnosticText } from "../observability/redaction.js";
import {
  BEGINNER_EVIDENCE_LINES,
  EXPERIENCE_LEVEL_STORAGE_KEY,
} from "./experience-level.js";

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
  const scenarioIds = escapeHtml(PHASE_E_SCENARIOS.map((s) => s.id).join(", "));
  // Single source of truth: the inline script embeds the experience-level
  // module constants (JSON-escaped for <script> context). The server ships the
  // same page for every operator; disclosure happens in the browser only.
  const embeddedLines = JSON.stringify(BEGINNER_EVIDENCE_LINES)
    .replace(/<\//g, "\\u003c/");
  const storageKey = JSON.stringify(EXPERIENCE_LEVEL_STORAGE_KEY);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sovereign ALZ — Local Operator</title>
<style>
:root{color-scheme:light;--bg:#f5f5f0;--ink:#172a27;--muted:#52645e;--edge:#d5dfd7;--accent:#285848}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,sans-serif}
main{max-width:930px;margin:0 auto;padding:34px 20px 70px}header{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}
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
.levels{display:flex;gap:6px;align-items:center}
.levels button{margin:0;background:#e5ede7;color:var(--ink);border:1px solid var(--edge);font-size:13px;padding:8px 14px;border-radius:40px;font-weight:650}
.levels button[aria-pressed="true"]{background:var(--accent);color:#fff;border-color:var(--accent)}
.levels button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.beginner-cards{display:grid;gap:14px;margin-top:14px}
.card{display:block;width:100%;text-align:left;background:#fff;color:var(--ink);border:1px solid var(--edge);border-radius:12px;padding:16px 18px;font-weight:400}
.card strong{display:block;font-size:17px;margin-bottom:4px}
.card.primary{border:2px solid var(--accent)}
.badge{display:inline-block;background:#e5ede7;color:var(--ink);border-radius:40px;padding:2px 10px;font-size:11px;font-weight:650;margin-left:8px}
body[data-level="BEGINNER"] .advanced-only{display:none}
body:not([data-level="BEGINNER"]) .beginner-only{display:none}
body:not([data-level="EXPERT"]) .expert-only{display:none}
#beginnerProof{font-weight:650}
code{background:#f7f9f7;padding:2px 6px;border-radius:6px;font:13px ui-monospace,monospace;overflow-wrap:anywhere}
</style></head><body data-level="BEGINNER"><main>
<header><strong>SOVEREIGN ALZ</strong><span class="tag">LOCAL • PREVIEW ONLY</span>
<nav class="levels" role="group" aria-label="Experience level">
<button type="button" data-level="BEGINNER" aria-pressed="false">Beginner</button>
<button type="button" data-level="ADVANCED" aria-pressed="false">Advanced</button>
<button type="button" data-level="EXPERT" aria-pressed="false">Expert</button>
</nav></header>
<h1>Private Agent Workspace</h1><p>Explore governed landing-zone assessments, review private-model findings,
and verify safe infrastructure previews. No deployments, cloud changes or automatic approvals.</p>
<section class="panel beginner-only" aria-label="Recommended next steps">
<h2>What would you like to do?</h2>
<p id="beginnerState" role="status" aria-live="polite">Ready</p>
<div class="beginner-cards">
<button type="button" class="card primary" data-mode="matrix-offline">
<strong>Explore governed scenarios<span class="badge">Recommended</span></strong>
<small>See how this protected workspace works. Nothing is changed anywhere.</small>
</button>
<button type="button" class="card" data-mode="chaos">
<strong>Check resilience &amp; backups</strong>
<small>Practice backup and recovery checks safely.</small>
</button>
</div>
<p id="beginnerProof" role="status" aria-live="polite">Choose an action to see how this workspace protects you.</p>
<p><small>Deeper analysis with private models on this machine is available at the Advanced level.</small></p>
</section>
<section class="panel advanced-only">
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
<section class="panel expert-only" aria-label="Expert reference">
<h2>Expert reference</h2>
<p><small>Equivalent CLI commands, run from the repository root:</small></p>
<ul>
<li><code>npx tsx src/cli/private-agent-matrix.ts --offline-fixture</code> — matrix-offline</li>
<li><code>npx tsx src/cli/private-agent-matrix.ts --live-models</code> — matrix-live</li>
<li><code>npx tsx src/cli/qualify-aws-terraform-agent.ts --live-models</code> — aws-review</li>
<li><code>npx tsx src/cli/chaos-pillars.ts</code> — chaos</li>
</ul>
<p><small>Scenario ids: ${scenarioIds}</small></p>
</section>
<section class="panel advanced-only"><h2>Execution and evidence</h2>
<p id="state" role="status" aria-live="polite">IDLE</p>
<p id="basis">Choose a workflow to view its evidence classification.</p>
<div class="line"></div><div id="output" aria-live="polite">No scenario executed yet.</div>
</section><p class="footer">Localhost-only session • One run at a time • ACT permanently disabled in this accelerator release.
Offline results cannot qualify live models, live-cloud discovery or a real recovery test.</p>
</main>
<script nonce="${escapeHtml(token)}">
const LEVELS=["BEGINNER","ADVANCED","EXPERT"];
const STORAGE_KEY=${storageKey};
const BEGINNER_LINES=${embeddedLines};
const form=document.querySelector('#run'),mode=document.querySelector('#mode'),scenario=document.querySelector('#scenario');
const state=document.querySelector('#state'),basis=document.querySelector('#basis'),output=document.querySelector('#output'),start=document.querySelector('#start');
const proof=document.querySelector('#beginnerProof'),beginnerState=document.querySelector('#beginnerState');
let level='BEGINNER',lastState=null;
function parseLevel(value){return LEVELS.includes(value)?value:'BEGINNER';}
function loadLevel(){try{return parseLevel(localStorage.getItem(STORAGE_KEY));}catch{return 'BEGINNER';}}
function storeLevel(value){try{localStorage.setItem(STORAGE_KEY,value);}catch{}}
function beginnerLine(raw){return BEGINNER_LINES[raw]||raw;}
const STATUS_LINES={IDLE:'Ready',RUNNING:'Running — this may take a few minutes',
  PASS:'Finished — this check passed safely',BLOCKED:'This check could not run — switch to Advanced for the technical reason'};
function renderState(){
  if(!lastState)return;
  if(level==='BEGINNER'){
    // Raw classification strings and terminal output never enter the Beginner DOM.
    beginnerState.textContent=STATUS_LINES[lastState.status]||lastState.status;
    proof.textContent=beginnerLine(lastState.evidenceBasis);
    basis.textContent='';output.textContent='';
  }else{
    basis.textContent=lastState.evidenceBasis;
    output.textContent=lastState.output||'No output yet.';
    proof.textContent='';beginnerState.textContent='';
  }
  start.disabled=lastState.status==='RUNNING';
}
function apply(){
  document.body.dataset.level=level;
  document.querySelectorAll('.levels button').forEach(function(button){
    button.setAttribute('aria-pressed',String(button.dataset.level===level));
  });
  renderState();
}
function setLevel(next){level=parseLevel(next);storeLevel(level);apply();}
document.querySelectorAll('.levels button').forEach(function(button){
  button.addEventListener('click',function(){setLevel(button.dataset.level);});
});
function update(){
  const available=mode.value==='matrix-offline'||mode.value==='matrix-live';
  scenario.disabled=!available; if(!available)scenario.value='all';
}
mode.addEventListener('change',update);
async function refresh(){
  try {
    const res=await fetch('/state',{cache:'no-store'});if(!res.ok)return;
    lastState=await res.json();renderState();
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
document.querySelectorAll('.card[data-mode]').forEach(function(card){
  card.addEventListener('click',function(){
    if(start.disabled)return;
    mode.value=card.dataset.mode;update();form.requestSubmit();
  });
});
level=loadLevel();apply();update();
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
      state = { ...state, status: "PASS", output: sanitizeDiagnosticText(output.slice(-15000), 15000) };
    }).catch((error) => {
      // Emit class/status only; no raw secrets, model transcripts, or cloud credentials.
      const message = error instanceof Error ? error.message : "UNKNOWN_FAILURE";
      state = { ...state, status: "BLOCKED",
        output: sanitizeDiagnosticText(message.slice(0, 15000), 15000) };
    });
  });
  return { server, getState: () => ({ ...state }) };
}
