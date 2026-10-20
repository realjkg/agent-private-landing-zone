#!/usr/bin/env node
/**
 * Compact local test runner. Full unmodified stdout/stderr is saved to a log;
 * the terminal only receives one animated status line and the real result.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dir = join(root, ".runs", "tests");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = join(dir, stamp + ".log");
const latest = join(dir, "latest.log");
const log = createWriteStream(logFile, { flags: "wx", mode: 0o600 });
const steps = [
  ["Build UI", ["run", "build:ui"]],
  ["Node tests", ["run", "test:node"]],
  ["UI tests", ["run", "test:ui"]],
];
const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const started = Date.now();
let active = null;
let spinner = null;
let stepName = "";
let frame = 0;
let stopping = false;
let nodeSummary = "";
let recent = "";
const tty = process.stdout.isTTY && process.env.CI !== "true";
const elapsed = () => {
  const seconds = Math.floor((Date.now() - started) / 1000);
  return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
};
const clear = () => { if (tty) process.stdout.write("\r\x1b[2K"); };
const redraw = () => { if (tty) { clear(); process.stdout.write(frames[frame++ % frames.length] + " " + stepName + "… " + elapsed() + " elapsed"); } };
const finishSpinner = () => {
  if (spinner) clearInterval(spinner);
  spinner = null;
  clear();
};
function consume(chunk) {
  const text = chunk.toString("utf8");
  log.write(text);
  recent = (recent + text).slice(-120_000);
  // The node runner normally prints summary counters at the end.
  for (const line of text.split(/\r?\n/)) {
    if (/^(?:ℹ |# )(?:tests|pass|fail|skipped)\s+\d+/.test(line)) nodeSummary += line + "\n";
  }
}
function runStep(name, args) {
  stepName = name;
  if (!tty) console.log("· " + name + "…");
  redraw();
  return new Promise(resolve => {
    const child = spawn("npm", args, {
      cwd: root, env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"], shell: false
    });
    active = child;
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", err => { consume(Buffer.from("\nPROCESS_ERROR: " + err.message + "\n")); });
    child.on("close", (code, signal) => { active = null; resolve(code === null ? (signal ? 130 : 1) : code); });
  });
}
function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (active) active.kill(signal);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGHUP", () => stop("SIGHUP"));

if (tty) spinner = setInterval(redraw, 100);
log.write("ALZ local test run: " + new Date(started).toISOString() + "\n");
let exitCode = 0;
for (const [name, args] of steps) {
  if (stopping) { exitCode = 130; break; }
  const code = await runStep(name, args);
  if (code !== 0) { exitCode = code; break; }
}
finishSpinner();
const counters = Object.fromEntries([...nodeSummary.matchAll(/^(?:ℹ |# )(tests|pass|fail|skipped)\s+(\d+)/gm)].map(x => [x[1], Number(x[2])]));
const summary = counters.pass === undefined ? "" :
  counters.pass + " passed · " + (counters.fail ?? 0) + " failed · " + (counters.skipped ?? 0) + " skipped · ";
console.log((exitCode === 0 ? "✓ " : "✖ ") + (exitCode === 0 ? "ALZ tests passed" : stepName + " failed") + " · " + summary + elapsed());
console.log("  Log: " + join(".runs", "tests", "latest.log"));
if (exitCode !== 0) {
  const all = recent.split(/\r?\n/);
  const failures = all.filter(line => /(?:^\s*[✖×]|not ok\b|AssertionError|Error \[|error TS\d+|FAIL\b)/i.test(line));
  for (const line of failures.slice(-8)) console.error("  " + line.slice(0, 240));
  console.error("  Full failure details: " + logFile);
}
await new Promise(resolve => log.end(resolve));
try { copyFileSync(logFile, latest); } catch(err) {
  console.error("Could not update latest.log: " + err.message);
  if (exitCode === 0) exitCode = 1;
}
process.exitCode = exitCode;
