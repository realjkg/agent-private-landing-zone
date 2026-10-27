import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { homedir, release as osRelease, type as osType } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { platformKey } from "../deps/pins.js";
import { fileSha256 } from "../lifecycle/app-install.js";
import { buildPlatformEvidence, type EvidenceOutcome } from "../lifecycle/evidence.js";
import { acquireRunLock, Journal, JournalError, type JourneyId } from "../lifecycle/journal.js";
import { JOURNEY_IDS, JOURNEYS, runJourney, type RunReport, type StepContext } from "../lifecycle/journeys.js";
import { interceptStopSignals } from "../tools/process.js";
import { EXIT, processTerminal, type HumanTerminal } from "./teardown-driver.js";

/**
 * `./alz lifecycle`: the packaged release lifecycle runner (docs/operator-guide.md, "Packaged release lifecycle"). A person
 * at a terminal on a disposable host runs the journeys against a release archive; every step is journaled, a rerun
 * resumes where an interrupted run stopped, and the result is the `platform:<os-arch>` gate report plus the real
 * admission review's verdict on it. The runner produces evidence. It never submits or admits it, and the console's job
 * table never starts it (its catalog entry is a handoff). `--synthetic` labels the report SYNTHETIC and makes it never
 * submittable, for rehearsals and tests.
 */
export type LifecycleDeps = {
  terminal?: HumanTerminal;
  out?: (text: string) => void;
  home?: string;
  platform?: string;
  arch?: string;
  osVersion?: string;
  now?: () => Date;
  pidAlive?: (pid: number) => boolean;
  launch?: StepContext["launch"];
  /** Ends the process on a second stop signal. Tests inject it; the default is process.exit. */
  exit?: (code: number) => void;
};

export const LIFECYCLE_USAGE = [
  "  ./alz lifecycle <clean-install|uninstall|partial-install-recovery|all> --artifact FILE.tgz --evidence DIR --host ID --commit SHA [--home DIR] [--synthetic]",
  "      runs the packaged release lifecycle journeys on this host and writes the platform gate report under DIR;",
  "      a live run belongs on a disposable host only: it installs into and removes from that host's own ~/.alz/app, and it",
  "      asks you to type LIFECYCLE LIVE <host> first; it produces evidence and never submits it. --synthetic labels the",
  "      report SYNTHETIC, which is never submittable, and only then may --home point at a throwaway folder.",
  "      Exit 0 when every step passed, 2 when one did not or the run was stopped.",
];

type Parsed = { journeys: JourneyId[]; artifact: string; evidence: string; host: string; commit: string; home?: string; synthetic: boolean };

const sha40 = /^[0-9a-f]{40}$/;

function parse(args: string[]): { ok: true; value: Parsed } | { ok: false; reason: string } {
  const [first, ...rest] = args;
  if (first === undefined || first === "help" || first.startsWith("-")) return { ok: false, reason: "Name a journey: clean-install, uninstall, partial-install-recovery, or all." };
  const journeys: JourneyId[] = first === "all" ? [...JOURNEY_IDS] : JOURNEY_IDS.includes(first as JourneyId) ? [first as JourneyId] : [];
  if (journeys.length === 0) return { ok: false, reason: "Unknown journey \"" + first + "\". Choose clean-install, uninstall, partial-install-recovery, or all." };
  const options = new Map<string, string>();
  let synthetic = false;
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index]!;
    if (item === "--synthetic") { synthetic = true; continue; }
    if (!/^--(artifact|evidence|host|commit|home)$/.test(item) || index + 1 >= rest.length || rest[index + 1]!.startsWith("--")) {
      return { ok: false, reason: "Unknown or incomplete option \"" + item + "\"." };
    }
    options.set(item.slice(2), rest[index + 1]!);
    index += 1;
  }
  const artifact = options.get("artifact");
  const evidence = options.get("evidence");
  const host = options.get("host");
  const commit = options.get("commit");
  if (!artifact || !evidence || !host || !commit) return { ok: false, reason: "--artifact, --evidence, --host and --commit are all required." };
  if (!sha40.test(commit)) return { ok: false, reason: "--commit must be the release's full 40-character source commit." };
  if (host.trim() === "" || host === "UNKNOWN") return { ok: false, reason: "--host must name the disposable host (not UNKNOWN)." };
  const home = options.get("home");
  // A live report describes the host's own user folder. A throwaway folder is a rehearsal, which is what --synthetic is for.
  if (home !== undefined && !synthetic) return { ok: false, reason: "--home is for rehearsals only: add --synthetic, or leave --home out so the live run uses this host's own user folder." };
  return { ok: true, value: { journeys, artifact: resolve(artifact), evidence: resolve(evidence), host, commit, ...(home ? { home: resolve(home) } : {}), synthetic } };
}

export async function runLifecycleCommand(args: string[], deps: LifecycleDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => { process.stdout.write(text); });
  const terminal = deps.terminal ?? processTerminal();
  const parsed = parse(args);
  if (!parsed.ok) {
    out(parsed.reason + "\n" + LIFECYCLE_USAGE.join("\n") + "\n");
    return EXIT.ERROR;
  }
  const input = parsed.value;
  if (!input.synthetic && (!terminal.stdinIsTTY || !terminal.stdoutIsTTY)) {
    out("The lifecycle runner needs a person at an interactive Terminal window on the disposable host. Nothing was run.\n");
    return EXIT.BLOCKED;
  }
  const platform = platformKey(deps.platform ?? process.platform, deps.arch ?? process.arch);
  if (!platform) {
    out("This computer type is not one the release qualifies on, so no platform gate report can be made. Nothing was run.\n");
    return EXIT.BLOCKED;
  }
  let artifactSha256: string;
  try {
    if (!lstatSync(input.artifact).isFile()) throw new Error("not a file");
    artifactSha256 = await fileSha256(input.artifact);
  } catch {
    out("The release archive could not be read: " + input.artifact + "\n");
    return EXIT.ERROR;
  }
  const rawHome = input.home ?? deps.home ?? homedir();
  // A live run uses the host's own user folder. An empty or relative HOME would resolve against the current folder instead,
  // and the report would describe that folder as the user's.
  if (!input.synthetic && (rawHome === "" || !isAbsolute(rawHome))) {
    out("The user folder (HOME) is " + (rawHome === "" ? "empty" : "not an absolute path (" + rawHome + ")") +
      ", so a live run cannot tell which folder is this host's own. Set HOME to the user's absolute folder path and run it again. Nothing was run.\n");
    return EXIT.BLOCKED;
  }
  const home = resolve(rawHome);
  const label = input.synthetic ? "SYNTHETIC" : "LIVE";
  if (!input.synthetic) {
    // A live run changes this host's own user folder. The person at the terminal confirms the host by name before anything runs.
    const phrase = "LIFECYCLE LIVE " + input.host;
    terminal.write("\nThis is a LIVE lifecycle run on host " + input.host + ". It installs the release into " + join(home, ".alz", "app") +
      " and removes it again, and its report names this host. Run it on a disposable host only, never on a working machine.\n" +
      "Type " + phrase + " to continue, or anything else to stop.\n");
    const typed = (await terminal.ask("> ")).trim();
    if (typed !== phrase) {
      out("Stopped: the confirmation was not typed. Nothing was run.\n");
      return EXIT.BLOCKED;
    }
  }
  mkdirSync(input.evidence, { recursive: true, mode: 0o700 });
  let journal: Journal;
  let unlock: () => void;
  try {
    unlock = acquireRunLock(join(input.evidence, "lifecycle", "run.lock"), deps.pidAlive);
  } catch (error) {
    out((error instanceof JournalError ? error.message : "The evidence folder could not be locked.") + "\n");
    return EXIT.BLOCKED;
  }
  try {
    journal = new Journal(join(input.evidence, "lifecycle", "journal.jsonl"), { artifactSha256, sourceCommit: input.commit, label, home, host: input.host, platform });
  } catch (error) {
    unlock();
    out((error instanceof JournalError ? error.message : "The journal could not be opened.") + "\n");
    return EXIT.BLOCKED;
  }
  out("Packaged release lifecycle (" + label + ") on " + platform + ", artifact " + artifactSha256.slice(0, 12) + ", commit " + input.commit.slice(0, 12) + ", host " + input.host + ", home " + home + "\n");
  if (input.synthetic) out("SYNTHETIC: this run qualifies nothing and its report is never submittable.\n");
  if (journal.entries().length > 0) out("Continuing the journal at " + journal.file + " (" + journal.entries().length + " lines).\n");

  let stopped = false;
  let signals = 0;
  const releaseSignals = interceptStopSignals(() => {
    signals += 1;
    if (signals === 1) {
      stopped = true;
      out("\nStopping after the current step. The journal keeps what finished; running the same command again continues from there. Press Ctrl-C again to leave at once.\n");
      return;
    }
    (deps.exit ?? ((code: number) => { process.exit(code); }))(EXIT.BLOCKED);
  });
  const runs: RunReport[] = [];
  let allPassed = true;
  try {
    for (const id of input.journeys) {
      const journey = JOURNEYS.find((item) => item.id === id)!;
      out(id + "\n");
      const run = await runJourney(journey, {
        home, artifact: input.artifact, artifactSha256, evidenceDir: input.evidence, journal,
        ...(deps.pidAlive ? { pidAlive: deps.pidAlive } : {}), ...(deps.launch ? { launch: deps.launch } : {}), ...(deps.now ? { now: deps.now } : {}),
        stopRequested: () => stopped, out: (line) => { out(line + "\n"); },
      });
      runs.push(run);
      if (run.steps.some((step) => step.status === "FAIL" || step.status === "BLOCKED")) allPassed = false;
      if (run.stopped || stopped) { allPassed = false; break; }
    }
  } finally {
    releaseSignals();
  }
  let evidence: EvidenceOutcome;
  try {
    evidence = await buildPlatformEvidence({
      evidenceDir: input.evidence, platform, osVersion: deps.osVersion ?? osType() + " " + osRelease(), sourceCommit: input.commit,
      targetHardwareId: input.host, artifactSha256, synthetic: input.synthetic, home, runs, ...(deps.now ? { now: deps.now } : {}),
    });
  } catch {
    unlock();
    out("The platform gate report could not be written under " + input.evidence + "\n");
    return EXIT.ERROR;
  } finally {
    unlock();
  }
  out("\nReport: " + evidence.reportFile + " (" + evidence.label + ")\n");
  out("Admission review (src/qualification/release-admission.ts): " + evidence.reviewStatus + (evidence.reviewBlockers.length > 0 ? " — " + evidence.reviewBlockers.join("; ") : "") + "\n");
  if (evidence.missingChecks.length > 0) out("Checks not yet passed for the platform gate: " + evidence.missingChecks.join(", ") + "\n");
  out(evidence.submittable
    ? "Submittable: yes. Hand the report to the owner's admission flow; nothing was submitted here.\n"
    : "Submittable: no" + (input.synthetic ? " (SYNTHETIC)" : "") + ". Nothing was submitted or admitted.\n");
  if (stopped) out("Stopped. Run the same command again to continue.\n");
  return allPassed ? EXIT.PASS : EXIT.BLOCKED;
}

/** True when `path` is a journal this runner wrote, for callers that want to know whether a rerun would resume. */
export function hasLifecycleJournal(evidenceDir: string): boolean {
  return existsSync(join(evidenceDir, "lifecycle", "journal.jsonl"));
}
