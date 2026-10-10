import { useCallback, useEffect, useRef, useState } from "react";

import { parseExperienceLevel, type ExperienceLevel } from "../experience-level.js";
import { prefersReducedMotion, scrollBehaviorFor, scrollIntoViewSafe } from "./motion";
import {
  fetchJobState,
  fetchModelAvailability,
  requestRun,
  type JobState,
  type ModelAvailability,
  type OperatorMode,
} from "./api";
import { BeginnerPath } from "./components/BeginnerPath";
import { CompliancePanels } from "./components/CompliancePanels";
import { CompliancePosture } from "./components/CompliancePosture";
import { ConnectorGallery } from "./components/ConnectorGallery";
import { ConnectorNotice } from "./components/ConnectorNotice";
import { EvidencePanel } from "./components/EvidencePanel";
import { ExpertReference } from "./components/ExpertReference";
import { LevelSwitcher } from "./components/LevelSwitcher";
import { ProtectionCard } from "./components/ProtectionCard";
import { SectionNav } from "./components/SectionNav";
import { PRIVATE_MODEL_MODES, WorkflowForm } from "./components/WorkflowForm";
import { readStoredLevel, storeLevel } from "./level-storage";

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
  const [mode, setMode] = useState<OperatorMode>("matrix-offline");
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
    setJobState(next);
  }, []);

  useEffect(() => {
    const poll = () => {
      void refresh();
    };
    poll();
    const interval = setInterval(poll, 1000);
    return () => clearInterval(interval);
  }, [refresh]);

  const changeLevel = useCallback((next: ExperienceLevel) => {
    // parseExperienceLevel is defense in depth: an unknown value can never
    // escalate disclosure (mirrors the D1 contract, tested in
    // test/experience-levels.test.ts).
    const parsed = parseExperienceLevel(next);
    setLevel(parsed);
    storeLevel(parsed);
  }, []);

  const running = launching || jobState?.status === "RUNNING";

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

  return (
    <div className="crt" data-level={level}>
      <main>
        <header>
          <strong className="brand">SOVEREIGN ALZ</strong>
          <span className="tag">LOCAL • PREVIEW ONLY</span>
          <LevelSwitcher level={level} onSelect={changeLevel} />
        </header>
        <h1>Private Agent Workspace</h1>
        <p className="intro">
          Explore governed landing-zone assessments, review private-model findings, and verify safe
          infrastructure previews. No deployments, cloud changes or automatic approvals.
        </p>
        {/* Conditional rendering (not CSS hiding) keeps the D1 ceiling literal:
            at Beginner the advanced/expert markup does not exist in the tree. */}
        {level === "BEGINNER" && (
          <BeginnerPath
            jobState={jobState}
            busy={running}
            sessionUnavailable={sessionUnavailable}
            onLaunch={launch}
          />
        )}
        {level === "BEGINNER" && <ProtectionCard />}
        {level === "BEGINNER" && <ConnectorNotice />}
        {level === "BEGINNER" && <CompliancePosture />}
        {level !== "BEGINNER" && <SectionNav />}
        {level !== "BEGINNER" && (
          <section className="panel advanced-only" id="workflow">
            <h2>Choose a workflow</h2>
            <WorkflowForm
              mode={mode}
              scenario={scenario}
              scenarioIds={props.scenarioIds}
              running={running}
              modelAvailability={modelAvailability}
              onRecheckModels={() => void checkModels()}
              onModeChange={setMode}
              onScenarioChange={setScenario}
              onSubmit={() => void launch(mode, scenario)}
            />
          </section>
        )}
        {level === "EXPERT" && <ExpertReference scenarioIds={props.scenarioIds} />}
        {level !== "BEGINNER" && (
          <EvidencePanel
            jobState={jobState}
            formError={formError}
            sessionUnavailable={sessionUnavailable}
            runScenario={lastRunScenario}
            ref={evidenceRef}
          />
        )}
        {level !== "BEGINNER" && <ConnectorGallery level={level} />}
        {level !== "BEGINNER" && <CompliancePanels level={level} />}
        <p className="footer">
          Localhost-only session • One run at a time • ACT permanently disabled in this accelerator
          release. Offline results cannot qualify live models, live-cloud discovery or a real
          recovery test.
        </p>
      </main>
    </div>
  );
}
