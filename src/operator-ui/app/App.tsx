import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { parseExperienceLevel, type ExperienceLevel } from "../experience-level.js";
import { prefersReducedMotion, scrollBehaviorFor, scrollIntoViewSafe } from "./motion";
import {
  fetchJobState,
  fetchModelAvailability,
  requestRun,
  sameJobState,
  type JobState,
  type ModelAvailability,
  type OperatorMode,
} from "./api";
import { BeginnerPath } from "./components/BeginnerPath";
import { DeploymentContext } from "./components/DeploymentContext";
import { AwsRolePreparation } from "./components/AwsRolePreparation";
import { CostEvidenceIntake } from "./components/CostEvidenceIntake";
import { CompliancePosture } from "./components/CompliancePosture";
import { ConnectorNotice } from "./components/ConnectorNotice";
import { EvidencePanel } from "./components/EvidencePanel";
import { ExpertReference } from "./components/ExpertReference";
import { LevelSwitcher } from "./components/LevelSwitcher";
import { ProtectionCard } from "./components/ProtectionCard";
import { Arrive } from "./components/Arrive";
import { ViewNav } from "./components/ViewNav";
import { PRIVATE_MODEL_MODES, WorkflowForm } from "./components/WorkflowForm";
import { readStoredLevel, storeLevel } from "./level-storage";
import { OperationsEntry } from "./operations/OperationsEntry";
import { useRoute } from "./route";

// Reference (connectors and compliance detail) is its own chunk: it downloads
// when that area opens, not with the first paint.
const ReferenceView = lazy(() => import("./components/ReferenceView"));
// The pilot wizard is its own chunk too: it downloads when the area opens. It reaches the server only through its own token-guarded routes.
const PilotWizard = lazy(() => import("./pilot/PilotWizard"));

const POLL_RUNNING_MS = 1000;
// Nothing changes while idle unless a run starts elsewhere; check calmly.
const POLL_IDLE_MS = 5000;

export type OperatorAppProps = {
  /** Per-session CSRF token, read from the server-injected carrier input. */
  csrfToken: string;
  /** Qualification scenario ids, frozen at build time (see scripts/prerender-ui.tsx). */
  scenarioIds: readonly string[];
  /** Test seam: initial job state. Production runs always start null. */
  initialJobState?: JobState | null;
  /** Test seam: initial level. Production reads localStorage (default BEGINNER). */
  initialLevel?: ExperienceLevel;
};

/**
 * The operator console. Presentation-only by construction: the experience
 * level changes what is rendered, never what is sent to the server — every
 * run posts exactly mode, scenario and the CSRF token.
 */
export function OperatorApp(props: OperatorAppProps) {
  const [level, setLevel] = useState<ExperienceLevel>(
    props.initialLevel ? parseExperienceLevel(props.initialLevel) : readStoredLevel,
  );
  const [jobState, setJobState] = useState<JobState | null>(props.initialJobState ?? null);
  // Prefer the real local Qwen/Mistral path; the existing model probe
  // reverts to offline fixtures if a private model is unavailable.
  // Selection alone never starts inference or obtains cloud authority.
  const [mode, setMode] = useState<OperatorMode>("matrix-live");
  const [scenario, setScenario] = useState("all");
  const [launching, setLaunching] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  // Scenario of the last accepted run, for the completed-run summary line.
  // The server's JobState carries the workflow title but not the scenario id,
  // so the client supplies the one fact only it knows — or none, after a
  // reload, rather than guessing.
  const [lastRunScenario, setLastRunScenario] = useState<string | null>(null);
  const evidenceRef = useRef<HTMLElement | null>(null);
  // Advisory only: explains up front whether the private-model workflows can
  // run on this machine. The server never consults it when validating a run.
  const [modelAvailability, setModelAvailability] = useState<ModelAvailability | null>(null);

  const checkModels = useCallback(async () => {
    const next = await fetchModelAvailability();
    setModelAvailability(next);
    // A selection the form now disables falls back to the offline default.
    if (next?.status === "UNAVAILABLE") {
      setMode((current) => (PRIVATE_MODEL_MODES.has(current) ? "matrix-offline" : current));
    }
  }, []);

  useEffect(() => {
    void checkModels();
  }, [checkModels]);

  const refresh = useCallback(async () => {
    const next = await fetchJobState();
    if (next === null) {
      setSessionUnavailable(true);
      return;
    }
    setSessionUnavailable(false);
    // An unchanged poll keeps the same object, so nothing re-renders.
    setJobState((previous) => (sameJobState(previous, next) ? previous : next));
  }, []);

  const polling = jobState?.status === "RUNNING";

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const poll = () => {
      if (!document.hidden) void refresh();
    };
    const interval = setInterval(poll, polling ? POLL_RUNNING_MS : POLL_IDLE_MS);
    // Catch up the moment the tab is shown again.
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh, polling]);

  const changeLevel = useCallback((next: ExperienceLevel) => {
    // parseExperienceLevel is defense in depth: an unknown value can never
    // escalate disclosure (mirrors the D1 contract, tested in
    // test/experience-levels.test.ts).
    const parsed = parseExperienceLevel(next);
    setLevel(parsed);
    storeLevel(parsed);
  }, []);

  const route = useRoute();
  // Reference starts at Advanced; a stale link at Beginner shows Home instead.
  const view = route.view === "reference" && level === "BEGINNER" ? "home" : route.view;
  const running = launching || jobState?.status === "RUNNING";

  const recheckModels = useCallback(() => void checkModels(), [checkModels]);

  const launch = useCallback(
    async (nextMode: OperatorMode, nextScenario?: string) => {
      if (running) return; // One run at a time — the server enforces this too.
      setLaunching(true);
      setFormError(null);
      const scenarioAvailable = nextMode === "matrix-offline" || nextMode === "matrix-live";
      const effectiveScenario = nextScenario ?? (scenarioAvailable ? scenario : "all");
      // Run feedback at the point of action: bring the execution panel into
      // view the moment a run starts (Advanced/Expert only — the panel does
      // not exist at Beginner, where the beginner status line narrates).
      scrollIntoViewSafe(evidenceRef.current, scrollBehaviorFor(prefersReducedMotion()));
      const outcome = await requestRun({
        mode: nextMode,
        scenario: effectiveScenario,
        token: props.csrfToken,
      });
      if (!outcome.accepted) setFormError(outcome.error ?? "Request denied");
      else setLastRunScenario(effectiveScenario);
      await refresh();
      setLaunching(false);
    },
    [running, scenario, props.csrfToken, refresh],
  );

  const submitForm = useCallback(() => void launch(mode, scenario), [launch, mode, scenario]);

  // The Home launch error belongs to Home only: on the Operations view the panel shows the job output,
  // so a stale launch refusal can never hide the result of a run started from a card.
  const evidenceFor = (error: string | null) => (
    <EvidencePanel
      jobState={jobState}
      formError={error}
      sessionUnavailable={sessionUnavailable}
      runScenario={lastRunScenario}
      ref={evidenceRef}
    />
  );

  return (
    <div className="crt" data-level={level}>
      <a className="skip-link" href="#main-content" onClick={(event) => {
        event.preventDefault();
        document.getElementById("main-content")?.focus();
      }}>
        Skip to main content
      </a>
      <header className="masthead">
        <strong className="brand">SOVEREIGN ALZ</strong>
        <span className="tag">LOCAL • CHANGES ONLY BY A PERSON</span>
        <LevelSwitcher level={level} onSelect={changeLevel} />
      </header>
      <ViewNav level={level} view={view} />
      <main id="main-content" tabIndex={-1}>
        <h1>Private Agent Workspace</h1>
        <p className="intro">
          Explore governed landing-zone assessments, review private-model findings, and verify safe
          infrastructure previews. Nothing here deploys or changes the cloud on its own: the guided Pilot apply
          area changes real systems only for a person who unlocks it, types each confirmation, and has approvals.
        </p>
        {level !== "BEGINNER" && (view === "home" || view === "operations") && <DeploymentContext />}
        {view === "operations" && <AwsRolePreparation />}
        {view === "operations" && <CostEvidenceIntake />}
        {sessionUnavailable && view !== "home" && (
          <p role="alert" className="session-banner">
            This console lost its local session — close it and start it again.
          </p>
        )}
        {view === "home" && (
          <>
            {/* Conditional rendering (not CSS hiding) keeps the D1 ceiling literal:
                at Beginner the advanced/expert markup does not exist in the tree. */}
            {level === "BEGINNER" && (
              <>
                <BeginnerPath
                  jobState={jobState}
                  busy={running}
                  sessionUnavailable={sessionUnavailable}
                  modelAvailability={modelAvailability}
                  onLaunch={launch}
                />
                <ProtectionCard />
                <ConnectorNotice />
                <CompliancePosture />
              </>
            )}
            {level !== "BEGINNER" && (
              <section className="panel advanced-only" id="workflow">
                <h2 id="home-title" tabIndex={-1}>Choose a workflow</h2>
                <WorkflowForm
                  mode={mode}
                  scenario={scenario}
                  scenarioIds={props.scenarioIds}
                  running={running}
                  modelAvailability={modelAvailability}
                  onRecheckModels={recheckModels}
                  onModeChange={setMode}
                  onScenarioChange={setScenario}
                  onSubmit={submitForm}
                />
              </section>
            )}
            {level === "EXPERT" && <ExpertReference scenarioIds={props.scenarioIds} />}
            {level !== "BEGINNER" && evidenceFor(formError)}
            <Arrive route={route} titleId="home-title" />
          </>
        )}
        {view === "operations" && (
          <>
            <OperationsEntry
              eager
              level={level}
              csrfToken={props.csrfToken}
              jobState={jobState}
              busy={running}
              onRefresh={refresh}
              modelAvailability={modelAvailability}
            />
            {level !== "BEGINNER" && evidenceFor(null)}
            <Arrive route={route} titleId="operations-title" />
          </>
        )}
        {view === "pilot" && (
          <Suspense fallback={<p role="status" className="loading">Loading the pilot wizard…</p>}>
            <PilotWizard level={level} />
            <Arrive route={route} titleId="pilot-title" />
          </Suspense>
        )}
        {view === "reference" && (
          <Suspense fallback={<p role="status" className="loading">Loading reference…</p>}>
            <ReferenceView level={level} />
            <Arrive route={route} titleId="reference-title" />
          </Suspense>
        )}
        <p className="footer">
          Localhost-only session • One run at a time • Infrastructure changes stay off unless the
          owner's pilot rules are switched on, and then only the Pilot apply area, with a person
          typing each confirmation, can make one. Offline results cannot qualify live models, live-cloud discovery or a real
          recovery test.
        </p>
      </main>
    </div>
  );
}
