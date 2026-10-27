import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { AppInstallError, appState, appFolder, appVersions, currentVersion, installApp, removeApp, APP_LAUNCHER } from "./app-install.js";
import { Journal, type JourneyId, type StepOutcome } from "./journal.js";

/**
 * The packaged release lifecycle journeys of slice C1, each a short list of named steps. A step is one of the seven
 * platform lifecycle checks (src/qualification/release-admission.ts, PLATFORM_LIFECYCLE_CHECKS) or a preparation for one.
 * Every step is journaled before and after it runs, is safe to run again (it reads the state on disk first), and writes
 * its own detail file, whose SHA-256 is the check's evidence. Steps never read or write outside the home's `~/.alz/app`
 * and the evidence folder.
 */
export type StepResult = { outcome: StepOutcome; code?: string; detail: Record<string, unknown> };
export type StepContext = {
  home: string;
  artifact: string;
  artifactSha256: string;
  evidenceDir: string;
  pidAlive?: (pid: number) => boolean;
  /** Runs the installed launcher and returns its stdout; injected by tests. Defaults to `bash <folder>/alz help` (node on Windows). */
  launch?: (folder: string) => string;
  now?: () => Date;
};
export type Step = { name: string; check?: boolean; run(ctx: StepContext): Promise<StepResult> };
export type Journey = { id: JourneyId; steps: readonly Step[] };

const DEAD_PID = 2 ** 22 + 7;

function defaultLaunch(folder: string): string {
  const options = { encoding: "utf8" as const, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], cwd: folder };
  return process.platform === "win32"
    ? execFileSync(process.execPath, [join(folder, "dist", "cli", "operator.js"), "help"], options)
    : execFileSync("bash", [join(folder, APP_LAUNCHER), "help"], options);
}

const fail = (code: string, detail: Record<string, unknown> = {}): StepResult => ({ outcome: "FAIL", code, detail: { code, ...detail } });

const install: Step = {
  name: "install", check: true,
  async run(ctx) {
    try {
      const installed = await installApp({ home: ctx.home, artifact: ctx.artifact, artifactSha256: ctx.artifactSha256,
        ...(ctx.pidAlive ? { pidAlive: ctx.pidAlive } : {}), ...(ctx.now ? { now: ctx.now } : {}) });
      const state = appState(ctx.home, installed.version);
      if (state !== "INSTALLED" || currentVersion(ctx.home) !== installed.version) return fail("APP_STATE_AFTER_INSTALL", { state });
      return { outcome: "PASS", detail: { version: installed.version, reused: installed.reused, swept: installed.swept, ...(installed.replaced ? { replaced: installed.replaced } : {}), state } };
    } catch (error) {
      return fail(error instanceof AppInstallError ? error.code : "APP_INSTALL_FAILED");
    }
  },
};

const launch: Step = {
  name: "launch", check: true,
  async run(ctx) {
    const version = currentVersion(ctx.home);
    if (version === undefined) return fail("APP_NOT_INSTALLED");
    try {
      const output = (ctx.launch ?? defaultLaunch)(appFolder(ctx.home, version));
      if (!output.includes("./alz")) return fail("APP_LAUNCH_UNEXPECTED_OUTPUT", { version });
      return { outcome: "PASS", detail: { version, outputSha256: sha(output) } };
    } catch {
      return fail("APP_LAUNCH_FAILED", { version });
    }
  },
};

const uninstall: Step = {
  name: "uninstall", check: true,
  async run(ctx) {
    const version = currentVersion(ctx.home);
    if (version === undefined) return fail("APP_NOT_INSTALLED");
    try {
      const outcome = removeApp(ctx.home, version);
      const state = appState(ctx.home, version);
      if (state !== "ABSENT" || currentVersion(ctx.home) !== undefined) return fail("APP_STATE_AFTER_UNINSTALL", { state });
      return { outcome: "PASS", detail: { version, outcome, state } };
    } catch (error) {
      return fail(error instanceof AppInstallError ? error.code : "APP_REMOVE_FAILED", { version });
    }
  },
};

/** The uninstall run again must change nothing and say so: "absent" for the version the journal's uninstall removed. */
const repeatUninstall: Step = {
  name: "repeat-uninstall", check: true,
  async run(ctx) {
    const versions = appVersions(ctx.home);
    if (versions.length > 0) return fail("APP_STILL_PRESENT", { versions });
    const current = currentVersion(ctx.home);
    if (current !== undefined) return fail("APP_STILL_CURRENT", { current });
    return { outcome: "PASS", detail: { outcome: "absent", versions: [] } };
  },
};

/**
 * Plants what a crashed install leaves (a partial folder, a copy renamed aside mid-swap, both under a pid proven dead) and an
 * unfinished final folder, then installs: the sweep must remove the leftovers and the unfinished folder must be replaced.
 */
const plantInterruption: Step = {
  name: "plant-interruption",
  async run(ctx) {
    const root = join(ctx.home, ".alz", "app");
    mkdirSync(join(root, "install.partial-" + DEAD_PID), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "install.partial-" + DEAD_PID, "half"), "half unpacked\n");
    mkdirSync(join(root, "0.0.0-planted.replaced-" + DEAD_PID), { recursive: true, mode: 0o700 });
    return { outcome: "PASS", detail: { planted: ["install.partial-" + DEAD_PID, "0.0.0-planted.replaced-" + DEAD_PID], deadPid: DEAD_PID } };
  },
};

const recover: Step = {
  name: "partial-install-recovery", check: true,
  async run(ctx) {
    const result = await install.run(ctx);
    if (result.outcome !== "PASS") return result;
    const swept = result.detail.swept as string[];
    const expected = ["install.partial-" + DEAD_PID, "0.0.0-planted.replaced-" + DEAD_PID];
    const names = swept.map((path) => basename(path));
    if (!expected.every((name) => names.includes(name))) return fail("APP_LEFTOVERS_NOT_SWEPT", { swept, expected });
    return { outcome: "PASS", detail: { ...result.detail, sweptNames: expected } };
  },
};

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export const JOURNEYS: readonly Journey[] = [
  { id: "clean-install", steps: [install, launch] },
  { id: "uninstall", steps: [uninstall, repeatUninstall] },
  { id: "partial-install-recovery", steps: [plantInterruption, recover, launch, uninstall] },
];
export const JOURNEY_IDS: readonly JourneyId[] = JOURNEYS.map((journey) => journey.id);

export type RunReport = {
  journey: JourneyId;
  steps: { name: string; check: boolean; status: "PASS" | "FAIL" | "BLOCKED" | "SKIPPED_ALREADY_PASSED"; code?: string; detailFile?: string }[];
  stopped: boolean;
};

export type RunOptions = StepContext & {
  journal: Journal;
  /** True once a stop was requested: the running step finishes, the next one is not started. */
  stopRequested?: () => boolean;
  out?: (line: string) => void;
};

/**
 * Runs one journey through the journal: a step the journal already shows finished with PASS is skipped; one it shows started
 * and never finished (interrupted) or failed is run again from its own state on disk; the first failure ends the journey.
 */
export async function runJourney(journey: Journey, opts: RunOptions): Promise<RunReport> {
  const report: RunReport = { journey: journey.id, steps: [], stopped: false };
  const checksDir = join(opts.evidenceDir, "lifecycle", "checks");
  mkdirSync(checksDir, { recursive: true, mode: 0o700 });
  for (const step of journey.steps) {
    const previous = opts.journal.record(journey.id, step.name);
    if (previous.status === "FINISHED" && previous.outcome === "PASS") {
      report.steps.push({ name: step.name, check: step.check === true, status: "SKIPPED_ALREADY_PASSED", detailFile: join(checksDir, journey.id + "." + step.name + ".json") });
      opts.out?.("  " + step.name + ": already passed in an earlier run, kept");
      continue;
    }
    // A stop signal received during a step (steps are synchronous work) is delivered by the event loop only after the step
    // returns: two turns let the handler run before the next step is considered.
    for (let turn = 0; turn < 2; turn += 1) await new Promise<void>((done) => { setImmediate(done); });
    if (opts.stopRequested?.()) {
      report.stopped = true;
      report.steps.push({ name: step.name, check: step.check === true, status: "BLOCKED", code: "LIFECYCLE_STOPPED" });
      break;
    }
    if (previous.status === "INTERRUPTED") opts.out?.("  " + step.name + ": an earlier run stopped here (pid " + previous.pid + "); running it again");
    const at = (opts.now?.() ?? new Date()).toISOString();
    opts.journal.start(journey.id, step.name, at);
    const result = await step.run(opts);
    const detailFile = join(checksDir, journey.id + "." + step.name + ".json");
    writeFileSync(detailFile, JSON.stringify({ journey: journey.id, step: step.name, outcome: result.outcome, at, ...result.detail }, null, 2) + "\n", { mode: 0o600 });
    opts.journal.finish(journey.id, step.name, result.outcome, (opts.now?.() ?? new Date()).toISOString(), result.code);
    report.steps.push({ name: step.name, check: step.check === true, status: result.outcome, ...(result.code ? { code: result.code } : {}), detailFile });
    opts.out?.("  " + step.name + ": " + result.outcome + (result.code ? " (" + result.code + ")" : ""));
    if (result.outcome !== "PASS") break;
  }
  // A signal during the last step is delivered only now; the caller must not start another journey after it.
  for (let turn = 0; turn < 2; turn += 1) await new Promise<void>((done) => { setImmediate(done); });
  if (opts.stopRequested?.()) report.stopped = true;
  return report;
}
