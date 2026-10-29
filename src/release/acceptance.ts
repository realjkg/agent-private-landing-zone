import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The tracked delivery plan for cloud journeys (config/acceptance/journeys.json), checked as code.
//
// A row is one cloud and one build path. Its six steps each hold one status, and a status is a claim this module checks
// against the repository: cited code must exist, cited tests must exist under their exact titles, and the console proof must
// be a test that drives the real pilot router, never a mocked page. There is no "complete": a path is implemented only when
// every step and every row proof passes. A single step is live only with its own owner-attested record from a successful apply
// (`./alz apply record-live`); a row is live only when every step passes and an evidence file names the commit, target, engine and outcome.
// Synthetic and live are separate claims; neither stands in for the other.

export const JOURNEY_STEPS = ["prepare", "preview", "approve", "execute", "observe", "cleanup"] as const;
export type JourneyStep = typeof JOURNEY_STEPS[number];
export const STEP_STATUSES = ["NOT_IMPLEMENTED", "BLOCKED", "SYNTHETIC_PASS", "LIVE_PASS"] as const;
export type StepStatus = typeof STEP_STATUSES[number];
export const ROW_PROOFS = ["blueprint", "independentVerification", "cleanupDisposition", "sourceBoundEvidence"] as const;
export type RowProof = typeof ROW_PROOFS[number];
/**
 * The six rows, in order: every cloud with its Terraform path and its native path. A row's `path` is the engine id the release
 * paths, the contract and the live record use (`row.path === engine`), so GCP's native path is GCP_API (decision D18,
 * docs/act-pilot-gcp-api-driver.md); "API-native" is only its display word.
 */
export const REQUIRED_ROWS: readonly { cloud: string; path: string }[] = [
  { cloud: "AWS", path: "TERRAFORM" }, { cloud: "AWS", path: "CDK" },
  { cloud: "AZURE", path: "TERRAFORM" }, { cloud: "AZURE", path: "BICEP" },
  { cloud: "GCP", path: "TERRAFORM" }, { cloud: "GCP", path: "GCP_API" },
];
const TEST_KINDS = ["ui", "positive", "denied", "interrupted", "recovery"] as const;
/** What a step needs besides its own tests before it can pass. */
const STEP_NEEDS: Partial<Record<JourneyStep, readonly RowProof[]>> = {
  execute: ["sourceBoundEvidence"],
  observe: ["blueprint", "independentVerification"],
  cleanup: ["cleanupDisposition"],
};
/** A console proof starts the real router (or the console server around it); a component test with a stubbed fetch does not. */
const REAL_CONSOLE = /\bcreatePilotRouter\b|\bcreateLocalOperatorServer\b/;

export type TestRef = {
  file: string;
  title: string;
  /** SHARED_ENGINE: the test exercises code this row shares with another row (for example the driver's signal handling) on that row's fixture. */
  scope?: "ROW" | "SHARED_ENGINE";
};
export type StepClaim = {
  status: StepStatus;
  code?: string[];
  tests?: Partial<Record<typeof TEST_KINDS[number], TestRef[]>>;
  /** Required for NOT_IMPLEMENTED: what is missing, in one sentence. */
  missing?: string;
  /** Required for BLOCKED: the exact dependency. */
  blockedBy?: string;
  /** Required for LIVE_PASS: the committed live record for this step (`./alz apply record-live`), naming its commit, cloud, engine and target. */
  liveEvidence?: string;
};
export type ProofClaim = { status: "NOT_IMPLEMENTED" | "SYNTHETIC_PASS"; code?: string[]; tests?: TestRef[]; missing?: string };
export type LiveClaim = { status: "NOT_IMPLEMENTED" | "BLOCKED" | "LIVE_PASS"; blockedBy?: string; missing?: string; evidence?: string };
export type JourneyRow = {
  cloud: string;
  path: string;
  steps: Record<JourneyStep, StepClaim>;
  proofs: Record<RowProof, ProofClaim>;
  live: LiveClaim;
};
export type JourneyMatrix = { schemaVersion: 1; focus: { cloud: string; path: string }; rows: JourneyRow[] };

export type RowReport = {
  cloud: string;
  path: string;
  steps: Record<JourneyStep, StepStatus>;
  /** The weakest step: a row is as far along as its least finished step. */
  status: StepStatus;
  /** True only when every step and every row proof passes synthetically. */
  implemented: boolean;
  live: LiveClaim["status"];
};
export type AcceptanceResult = { problems: string[]; rows: RowReport[] };

const parseJson = (body: string | undefined): unknown => { try { return body === undefined ? undefined : JSON.parse(body); } catch { return undefined; } };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length >= 10;

/** Checks every claim in the matrix against the repository at `root`. A claim that cannot be proved is a problem, never a pass. */
export function checkJourneyMatrix(matrix: unknown, root: string): AcceptanceResult {
  const problems: string[] = [];
  const reports: RowReport[] = [];
  const read = (path: string): string | undefined => {
    const full = join(root, path);
    return /^[A-Za-z0-9_./-]+$/.test(path) && !path.includes("..") && existsSync(full) ? readFileSync(full, "utf8") : undefined;
  };
  const checkCode = (where: string, code: unknown): boolean => {
    if (!Array.isArray(code) || code.length === 0) { problems.push(where + ": cites no code"); return false; }
    const missing = code.filter((path) => typeof path !== "string" || read(path) === undefined);
    for (const path of missing) problems.push(where + ": code " + String(path) + " does not exist");
    return missing.length === 0;
  };
  /** True when the test file exists and holds a test with exactly this title. */
  const resolves = (where: string, ref: unknown): ref is TestRef => {
    if (!isRecord(ref) || typeof ref.file !== "string" || typeof ref.title !== "string" || (ref.scope !== undefined && ref.scope !== "ROW" && ref.scope !== "SHARED_ENGINE")) {
      problems.push(where + ": a test reference needs file, title and an optional scope of ROW or SHARED_ENGINE");
      return false;
    }
    const body = read(ref.file);
    if (body === undefined) { problems.push(where + ": test file " + ref.file + " does not exist"); return false; }
    if (!body.includes('test("' + ref.title + '"')) { problems.push(where + ": " + ref.file + " has no test titled " + JSON.stringify(ref.title)); return false; }
    return true;
  };

  if (!isRecord(matrix) || matrix.schemaVersion !== 1 || !Array.isArray(matrix.rows) || !isRecord(matrix.focus)) {
    return { problems: ["the matrix needs schemaVersion 1, a focus and rows"], rows: [] };
  }
  const keys = matrix.rows.map((row) => isRecord(row) ? row.cloud + "/" + row.path : "?");
  const wanted = REQUIRED_ROWS.map((row) => row.cloud + "/" + row.path);
  if (keys.join(",") !== wanted.join(",")) problems.push("rows must be exactly, in order: " + wanted.join(", ") + " (found " + keys.join(", ") + ")");
  if (!wanted.includes(matrix.focus.cloud + "/" + matrix.focus.path)) problems.push("focus must name one of the rows");

  for (const raw of matrix.rows) {
    if (!isRecord(raw) || !isRecord(raw.steps) || !isRecord(raw.proofs) || !isRecord(raw.live)) { problems.push("each row needs steps, proofs and live"); continue; }
    const row = raw as unknown as JourneyRow;
    const name = row.cloud + "/" + row.path;

    const proofPass: Partial<Record<RowProof, boolean>> = {};
    for (const proof of ROW_PROOFS) {
      const where = name + " proof " + proof;
      const claim = row.proofs[proof] as unknown;
      if (!isRecord(claim) || (claim.status !== "NOT_IMPLEMENTED" && claim.status !== "SYNTHETIC_PASS")) { problems.push(where + ": status must be NOT_IMPLEMENTED or SYNTHETIC_PASS"); continue; }
      const cited = Array.isArray(claim.tests) ? claim.tests.every((ref, index) => resolves(where + " test " + index, ref)) : claim.tests === undefined;
      if (claim.status === "NOT_IMPLEMENTED") {
        if (!text(claim.missing)) problems.push(where + ": NOT_IMPLEMENTED needs a sentence saying what is missing");
        if (claim.code !== undefined) checkCode(where, claim.code);
        proofPass[proof] = false;
      } else {
        const ok = checkCode(where, claim.code) && cited && Array.isArray(claim.tests) && claim.tests.length > 0;
        if (!Array.isArray(claim.tests) || claim.tests.length === 0) problems.push(where + ": SYNTHETIC_PASS needs at least one test");
        proofPass[proof] = ok;
      }
    }

    const statuses = {} as Record<JourneyStep, StepStatus>;
    for (const step of JOURNEY_STEPS) {
      const where = name + " " + step;
      const claim = row.steps[step] as unknown;
      if (!isRecord(claim) || !(STEP_STATUSES as readonly unknown[]).includes(claim.status)) {
        problems.push(where + ": status must be one of " + STEP_STATUSES.join(", "));
        statuses[step] = "NOT_IMPLEMENTED";
        continue;
      }
      const status = claim.status as StepStatus;
      statuses[step] = status;
      const tests = isRecord(claim.tests) ? claim.tests : {};
      if (claim.tests !== undefined && !isRecord(claim.tests)) problems.push(where + ": tests must be an object of ui, positive, denied, interrupted and recovery");
      for (const kind of Object.keys(tests)) if (!(TEST_KINDS as readonly string[]).includes(kind)) problems.push(where + ": unknown test kind " + kind);
      // Every citation must resolve whatever the status: a stale reference is a problem even on an unfinished step.
      const resolved: Record<string, TestRef[]> = {};
      for (const kind of TEST_KINDS) {
        const refs = tests[kind];
        if (refs === undefined) continue;
        if (!Array.isArray(refs)) { problems.push(where + " " + kind + ": must be a list"); continue; }
        resolved[kind] = refs.filter((ref, index) => resolves(where + " " + kind + " " + index, ref)) as TestRef[];
      }
      if (claim.code !== undefined || status === "SYNTHETIC_PASS" || status === "LIVE_PASS") checkCode(where, claim.code);

      if (status === "NOT_IMPLEMENTED" && !text(claim.missing)) problems.push(where + ": NOT_IMPLEMENTED needs a sentence saying what is missing");
      if (status === "BLOCKED" && !text(claim.blockedBy)) problems.push(where + ": BLOCKED needs the exact dependency");
      if (status === "SYNTHETIC_PASS" || status === "LIVE_PASS") {
        for (const kind of TEST_KINDS) if (!resolved[kind]?.length) problems.push(where + ": " + status + " needs a " + kind + " test");
        for (const kind of ["ui", "positive", "denied"] as const) {
          if (resolved[kind]?.length && !resolved[kind].some((ref) => (ref.scope ?? "ROW") === "ROW")) problems.push(where + ": the " + kind + " test must run on this row's own cloud and path (scope ROW)");
        }
        for (const ref of resolved.ui ?? []) {
          if (!REAL_CONSOLE.test(read(ref.file) ?? "")) problems.push(where + ": console test " + ref.file + " does not start the real pilot router, so it cannot prove the console works");
        }
        for (const proof of STEP_NEEDS[step] ?? []) if (!proofPass[proof]) problems.push(where + ": " + status + " needs the row proof " + proof);
      }
      if (status === "LIVE_PASS") {
        // One step can be live before the row is: its own owner-attested record, made from a successful apply's evidence.
        const record = parseJson(typeof claim.liveEvidence === "string" ? read(claim.liveEvidence) : undefined);
        if (!isRecord(record) || record.schemaVersion !== 1 || record.label !== "LIVE" || record.step !== step || record.cloud !== row.cloud ||
            record.engine !== row.path || typeof record.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(record.sourceCommit) ||
            record.outcome !== "SUCCEEDED" || !isRecord(record.target) || typeof record.target.account !== "string" ||
            ![record.artifactSha256, record.evidenceSha256, record.contractSha256].every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) ||
            typeof record.attestedBy !== "string" || record.attestedBy === "") {
          problems.push(where + ": LIVE_PASS needs liveEvidence: a LIVE record for this step, cloud and engine with the source commit, target, artifact, evidence hash and a SUCCEEDED outcome");
        }
      }
    }

    const live = row.live;
    if (!["NOT_IMPLEMENTED", "BLOCKED", "LIVE_PASS"].includes(live.status)) problems.push(name + " live: status must be NOT_IMPLEMENTED, BLOCKED or LIVE_PASS");
    if (live.status === "BLOCKED" && !text(live.blockedBy)) problems.push(name + " live: BLOCKED needs the exact dependency");
    if (live.status === "NOT_IMPLEMENTED" && !text(live.missing)) problems.push(name + " live: NOT_IMPLEMENTED needs a sentence saying what is missing");
    const implemented = JOURNEY_STEPS.every((step) => statuses[step] === "SYNTHETIC_PASS" || statuses[step] === "LIVE_PASS") && ROW_PROOFS.every((proof) => proofPass[proof]);
    if (live.status === "LIVE_PASS") {
      if (!implemented) problems.push(name + " live: LIVE_PASS needs every step and proof to pass synthetically first");
      const evidence = typeof live.evidence === "string" ? read(live.evidence) : undefined;
      let record: unknown;
      try { record = evidence === undefined ? undefined : JSON.parse(evidence); } catch { record = undefined; }
      if (!isRecord(record) || record.label !== "LIVE" || typeof record.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(record.sourceCommit) ||
          !isRecord(record.target) || record.engine !== row.path || record.cloud !== row.cloud || typeof record.outcome !== "string") {
        problems.push(name + " live: LIVE_PASS needs an evidence file labeled LIVE with sourceCommit, cloud, target, engine and outcome");
      }
    }

    const order = (status: StepStatus) => STEP_STATUSES.indexOf(status);
    const weakest = JOURNEY_STEPS.map((step) => statuses[step]).reduce((a, b) => order(b) < order(a) ? b : a);
    reports.push({ cloud: row.cloud, path: row.path, steps: statuses, status: weakest, implemented, live: live.status });
  }
  return { problems, rows: reports };
}

/** The matrix shipped in this repository. */
export function loadJourneyMatrix(root: string): unknown {
  return JSON.parse(readFileSync(join(root, "config", "acceptance", "journeys.json"), "utf8")) as unknown;
}
