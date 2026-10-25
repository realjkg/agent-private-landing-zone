import { useCallback, useEffect, useRef, useState } from "react";

import type { ExperienceLevel } from "../../experience-level.js";
import { PilotDialog } from "./PilotDialog";
import { ActDev1Setup } from "./ActDev1Setup";
import {
  answerDialog, cancelDialog, choosePath, fetchPilotState, forgetPilotToken, loadReview, startApply, startApprove, startPreflight, startPrepare, startSeal, setPilotToken, startOver,
  type PilotEnvironment, type PilotPath, type PilotReply, type PilotRun, type PilotState, type PreflightCheck, type PreparedFiles, type PrepareStop, type ReviewSummary, type RunResult,
} from "./pilot-api";
import {
  APPROVER_STEPS, BLOCKED, CLI_COMMANDS, COPY, RESULT_COPY, STEP_TITLES, SUPPORT_NOTE, actionWord, changeNotes, classifyResult, describeCheck, describeCounts, dialogCopy, reasonFor,
  type BlockedState,
} from "./pilot-copy";

const POLL_MS = 600;
const ENVIRONMENTS: readonly PilotEnvironment[] = ["DEV", "QA", "PROD"];
type Role = "OPERATOR" | "APPROVER";
type Readiness = { environment: PilotEnvironment; ready: boolean; checks: PreflightCheck[] };

// --- small shared pieces ------------------------------------------------------------------------------------

/** A stop with its reason and its next step. Every place the wizard cannot go on uses this, so none is a dead end. */
export function BlockedNotice(props: { state: BlockedState }) {
  const reason = BLOCKED[props.state];
  return (
    <div className="pilot-blocked" role="note" data-blocked={props.state}>
      <p><strong>Why you cannot go on:</strong> {reason.why}</p>
      <p><strong>What to do next:</strong> {reason.next}</p>
    </div>
  );
}

/** Help under a box: the sentence, then an example in code so a file name is shown as a file name. */
function Help(props: { id: string; text: string; example: string }) {
  return <p id={props.id}><small>{props.text} Example: <code>{props.example}</code></small></p>;
}

function CopyButton(props: { text: string; label?: string }) {
  const [state, setState] = useState<"" | "yes" | "no">("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(props.text); setState("yes"); } catch { setState("no"); }
  };
  return (
    <>
      <button type="button" className="pilot-secondary" onClick={() => void copy()}>{props.label ?? COPY.copy}</button>
      <span role="status" aria-live="polite" className="pilot-copy-status">{state === "yes" ? " " + COPY.copied : state === "no" ? " " + COPY.copyFailed : ""}</span>
    </>
  );
}

/** A refusal in plain words, with the code only where the level shows details. */
export function Reasoned(props: { step: string; code?: string; message?: string; level: ExperienceLevel; transcript?: string }) {
  const reason = reasonFor(props.code);
  return (
    <div className="pilot-reason" role="alert">
      <p><strong>Why it stopped:</strong> {reason.why}</p>
      <p><strong>What to do next:</strong> {reason.next}</p>
      {props.level === "BEGINNER" ? (
        <p><CopyButton text={SUPPORT_NOTE(props.step, props.code, props.message)} label={COPY.supportNote} /></p>
      ) : (
        <details className="pilot-details">
          <summary>{COPY.detailsLabel}</summary>
          <p>{COPY.detailsWhy}</p>
          <p>Reference: <code>{props.code ?? "none"}</code></p>
          {props.message && <p>Message: {props.message}</p>}
          {props.transcript && <pre className="output">{props.transcript}</pre>}
        </details>
      )}
    </div>
  );
}

function Progress(props: { role: Role; step: number }) {
  const steps = props.role === "APPROVER" ? APPROVER_STEPS : [1, 2, 3, 4, 5, 6];
  const index = Math.max(0, steps.indexOf(props.step));
  const text = "Step " + (index + 1) + " of " + steps.length + ": " + STEP_TITLES[props.step - 1];
  return (
    <div className="pilot-progress">
      <div className="pilot-bar" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={index + 1} aria-valuetext={text} aria-label="Progress">
        <div className="pilot-bar-fill" data-of={steps.length} data-fill={index + 1} />
      </div>
      <ol className="pilot-steps" aria-label="Steps">
        {steps.map((number, position) => (
          <li key={number} {...(number === props.step ? { "aria-current": "step" as const } : {})} data-done={position < index ? "true" : "false"}>
            <span className="pilot-step-number">{position + 1}</span> {STEP_TITLES[number - 1]}
          </li>
        ))}
      </ol>
      <p className="pilot-step-text" aria-hidden="true">{text}</p>
    </div>
  );
}

export function ChangeList(props: { review: ReviewSummary }) {
  const { review } = props;
  const risky = review.counts.delete + review.counts.replace + review.counts.forget > 0;
  return (
    <div className="pilot-review">
      <dl className="pilot-facts">
        <dt>Environment</dt><dd>{review.environment}</dd>
        <dt>Place</dt><dd><code>{review.target.account} | {review.target.backend} | {review.target.workspace}</code></dd>
        <dt>Change ID (first 12 characters)</dt><dd><code>{review.shortId}</code></dd>
      </dl>
      <h3>Change summary</h3>
      <p>Added: <strong>{review.counts.create}</strong> · Modified: <strong>{review.counts.update}</strong> ·
        Removed or replaced: <strong>{review.counts.delete + review.counts.replace + review.counts.forget}</strong></p>
      <p role="note">Governance: every change remains subject to policy checks and signed approvals.
        Access: a console session alone does not grant cloud permissions. Live role and organization controls must be verified before execution.</p>
      {risky && <p role="alert">This review includes removal or replacement. The AWS DEV canary permits an additive change only.
        Stop unless a separately authorized plan and policy explicitly allow this scope.</p>}
      <h3>What will change</h3>
      <ul className="pilot-counts">{describeCounts(review.counts).map((line) => <li key={line}>{line}</li>)}</ul>
      {risky && <p className="pilot-warning" role="note">{COPY.reviewDestructive}</p>}
      {review.changes.length === 0 ? <p>{COPY.noChanges}</p> : (
        <table className="pilot-table">
          <caption className="pilot-caption">The full list. You see names and kinds only, never values.</caption>
          <thead><tr><th scope="col">What happens</th><th scope="col">Name</th><th scope="col">Kind</th></tr></thead>
          <tbody>
            {review.changes.map((change, index) => (
              <tr key={index} data-action={change.action}>
                <td>{actionWord(change.action)}</td>
                <td><code>{change.address}</code>{changeNotes(change).map((note) => <small key={note}> ({note})</small>)}</td>
                <td><code>{change.type}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {review.changesOmitted > 0 && <p><small>{review.changesOmitted} {COPY.omitted}</small></p>}
    </div>
  );
}

/** What `prepare` bound, in plain words; the raw files stay behind Advanced. */
export function PreparedSummary(props: { prepared: PreparedFiles }) {
  const { summary, next, files } = props.prepared;
  const nextText = next.step === "seal" ? COPY.prepareNextSeal : next.step === "qualify" ? COPY.prepareNextCheck : COPY.prepareNextOwner;
  return (
    <div role="status" className="pilot-good pilot-prepared">
      <p><strong>{COPY.prepareDone}</strong></p>
      <dl className="pilot-facts">
        <dt>Cloud</dt><dd>{summary.provider}</dd>
        <dt>Build tool</dt><dd>{summary.engine === "TERRAFORM" ? "Terraform" : summary.engine === "CDK" ? "AWS CDK" : summary.engine}{summary.path === "SECONDARY" ? " (the other supported way)" : ""}</dd>
        <dt>Environment</dt><dd>{summary.environment}</dd>
        <dt>Account</dt><dd><code>{summary.account}</code></dd>
        {summary.region && <><dt>Region</dt><dd><code>{summary.region}</code></dd></>}
        <dt>Place</dt><dd><code>{summary.backend} | {summary.workspace}</code></dd>
        <dt>Project folder</dt><dd><code>{summary.projectRoot}</code> ({summary.fileCount} files)</dd>
        <dt>Tool version</dt><dd><code>{summary.engineVersion}</code></dd>
        <dt>Policy version</dt><dd><code>{summary.policyVersion}</code></dd>
      </dl>
      <p role="note">{COPY.prepareLocalOnly}</p>
      <p><strong>{nextText}</strong></p>
      <details className="pilot-details">
        <summary>{COPY.prepareAdvanced}</summary>
        <ul>
          <li>Request: <code>{files.request}</code> <CopyButton text={files.request} /></li>
          <li>Manifest: <code>{files.manifest}</code> <CopyButton text={files.manifest} /></li>
          <li>Record: <code>{files.record}</code></li>
        </ul>
        <p>Next step: {next.reason}</p>
        <ul>{props.prepared.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>
        <pre className="output">{JSON.stringify({ request: props.prepared.request, manifest: props.prepared.manifest }, null, 2)}</pre>
      </details>
    </div>
  );
}

// --- the wizard ------------------------------------------------------------------------------------------------

export type PilotWizardProps = { level: ExperienceLevel };

export default function PilotWizard(props: PilotWizardProps) {
  const { level } = props;
  const [state, setState] = useState<PilotState | null>(null);
  const [lost, setLost] = useState(false);
  const [token, setToken] = useState("");
  const [tokenWrong, setTokenWrong] = useState(false);
  const [checking, setChecking] = useState(false);
  const [role, setRole] = useState<Role>("OPERATOR");
  const [pathChoice, setPathChoice] = useState<PilotPath>("UI");
  const [step, setStep] = useState(1);
  const [environment, setEnvironment] = useState<PilotEnvironment>("DEV");
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [toolVersion, setToolVersion] = useState("");
  const [prepared, setPrepared] = useState<PreparedFiles | null>(null);
  const [requestPath, setRequestPath] = useState("");
  const [manifestPath, setManifestPath] = useState("");
  const [sealedPath, setSealedPath] = useState("");
  const [bundlePath, setBundlePath] = useState("");
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [reviewError, setReviewError] = useState<{ code: string; message: string } | null>(null);
  const [approvalsText, setApprovalsText] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [approverId, setApproverId] = useState("");
  const [signedPath, setSignedPath] = useState("");
  const [refusal, setRefusal] = useState<{ code: string; message: string } | null>(null);
  const [finalResult, setFinalResult] = useState<{ step: string; result: RunResult } | null>(null);
  const [starting, setStarting] = useState(false);
  const handled = useRef<string>("");
  const contentRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const unlocked = state?.unlocked === true;
  const run: PilotRun | null = state && state.unlocked ? state.run : null;
  const serverPath: PilotPath | null = state && state.unlocked ? state.path : null;
  const active = run !== null && run.status !== "DONE";

  const take = useCallback((reply: PilotReply): boolean => {
    if (reply.ok) { setState(reply.body); setLost(false); setRefusal(null); return true; }
    if (reply.code === "PILOT_UNREACHABLE") setLost(true); else setRefusal({ code: reply.code, message: reply.message });
    return false;
  }, []);

  const refresh = useCallback(async () => { take(await fetchPilotState()); }, [take]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Poll only while something is running or waiting for the person.
  useEffect(() => {
    if (!unlocked || !(active || starting)) return undefined;
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [unlocked, active, starting, refresh]);

  useEffect(() => { if (serverPath) setPathChoice(serverPath); }, [serverPath]);

  // Move focus to the heading of the step that opened, so a keyboard or screen reader user lands on it.
  useEffect(() => { headingRef.current?.focus(); }, [step, unlocked]);

  // The page behind a dialog is inert: no focus, no clicks, hidden from a screen reader.
  const dialog = run?.status === "WAITING" && run.dialog ? run.dialog : null;
  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    if (dialog) { element.setAttribute("inert", ""); element.setAttribute("aria-hidden", "true"); }
    else { element.removeAttribute("inert"); element.removeAttribute("aria-hidden"); }
  }, [dialog]);

  // What each finished step leaves behind. A run is handled once.
  useEffect(() => {
    if (!run || run.status !== "DONE" || !run.result || handled.current === run.id) return;
    handled.current = run.id;
    setStarting(false);
    const result = run.result;
    if (run.step === "preflight") {
      const data = result.data as { ready?: boolean; checks?: PreflightCheck[] } | undefined;
      setReadiness({ environment, ready: result.exit === 0 && data?.ready === true, checks: Array.isArray(data?.checks) ? data.checks : [] });
    } else if (run.step === "prepare") {
      const data = result.exit === 0 ? result.data as PreparedFiles | undefined : undefined;
      setPrepared(data ?? null);
      if (data) { setRequestPath(data.files.request); setManifestPath(data.files.manifest); }
    } else if (run.step === "seal" && result.exit === 0) {
      const data = result.data as { sealedPlanPath?: string; reviewBundlePath?: string } | undefined;
      setSealedPath(data?.sealedPlanPath ?? "");
      setBundlePath(data?.reviewBundlePath ?? "");
      setReview(result.summary ?? null);
    } else if (run.step === "approve" && result.exit === 0) {
      setSignedPath(result.savedPath ?? "");
    } else if (run.step === "apply") {
      setFinalResult({ step: "apply", result });
      setStep(6);
    }
  }, [run, environment]);

  const unlock = async () => {
    setChecking(true);
    setTokenWrong(false);
    setPilotToken(token);
    const reply = await fetchPilotState();
    setChecking(false);
    if (reply.ok && reply.body.unlocked) { setToken(""); take(reply); return; }
    forgetPilotToken();
    if (reply.ok) setTokenWrong(true); else take(reply);
  };

  const begin = async (action: () => Promise<PilotReply>) => {
    setStarting(true);
    const ok = take(await action());
    if (!ok) setStarting(false);
  };

  const submitAnswer = async (typed: string) => { if (dialog) take(await answerDialog(dialog.id, typed)); };
  const cancelQuestion = async () => { take(await cancelDialog()); };

  const reset = async () => {
    if (!take(await startOver())) return;
    setStep(1); setReadiness(null); setPrepared(null); setReview(null); setReviewError(null); setSealedPath(""); setBundlePath(""); setSignedPath("");
    setApprovalsText(""); setFinalResult(null); setRefusal(null); handled.current = "";
  };

  const chooseAndGo = async () => {
    if (!take(await choosePath(pathChoice))) return;
    if (pathChoice === "UI") setStep(role === "APPROVER" ? 4 : 2);
  };

  const dialogEnvironment = review?.environment ?? environment;
  const approvalPaths = approvalsText.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const locked = serverPath === "CLI";
  const stepOf = (number: number) => (step === number);
  const heading = (title: string) => <h3 ref={headingRef} tabIndex={-1} id="pilot-step-title">{title}</h3>;
  const runningText = (what: string) => (
    <p role="status" aria-live="polite" className="pilot-running">{active || starting ? what : ""}</p>
  );
  const lastRunFailed = run?.status === "DONE" && run.result && run.result.exit !== 0 ? run : null;
  const failureFor = (stepName: string) => lastRunFailed && lastRunFailed.step === stepName ? lastRunFailed : null;
  const prepareStop = failureFor("prepare")?.result?.data as PrepareStop | undefined;
  const needsToolVersion = failureFor("prepare")?.result?.code === "ENGINE_VERSION_REQUIRED";

  if (state === null) {
    return (
      <section className="panel pilot" aria-labelledby="pilot-title">
        <h2 id="pilot-title" tabIndex={-1}>{COPY.heading}</h2>
        {lost ? <p role="alert" className="session-banner">{COPY.sessionLost} {reasonFor("PILOT_UNREACHABLE").next}</p> : <p role="status">{COPY.working}</p>}
      </section>
    );
  }

  return (
    <section className="panel pilot" aria-labelledby="pilot-title" data-level={level}>
      <div ref={contentRef}>
        <h2 id="pilot-title" tabIndex={-1}>{COPY.heading}</h2>
        <p>{COPY.intro}</p>
        <p className="pilot-safety">{COPY.safetyLine}</p>
        {lost && <p role="alert" className="session-banner">{COPY.sessionLost} <small>{reasonFor("PILOT_UNREACHABLE").next}</small></p>}
        {refusal && <Reasoned step="console" code={refusal.code} message={refusal.message} level={level} />}

        {!unlocked && (
          <div className="pilot-step">
            <h3>{COPY.unlockTitle}</h3>
            <p>{COPY.unlockWhy}</p>
            <form onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
              <label htmlFor="pilot-token">{COPY.unlockLabel}</label>
              <input id="pilot-token" type="password" autoComplete="off" spellCheck={false} value={token} aria-describedby="pilot-token-help" onChange={(event) => setToken(event.target.value)} />
              <p id="pilot-token-help"><small>{COPY.unlockExample}</small></p>
              <button type="submit" disabled={token.trim() === "" || checking}>{checking ? COPY.unlockChecking : COPY.unlockButton}</button>
            </form>
            {tokenWrong && <p role="alert" className="pilot-error">{COPY.unlockWrong}</p>}
            {token.trim() === "" && <BlockedNotice state="LOCKED" />}
          </div>
        )}

        {unlocked && (
          <>
            <ActDev1Setup />
            <Progress role={role} step={step} />
            {serverPath !== null && (
              <p className="pilot-toolbar">
                <button type="button" className="pilot-secondary" disabled={active} onClick={() => void reset()}>{COPY.startOver}</button>{" "}
                <small>{COPY.startOverWhy}</small>
              </p>
            )}
            {runningText(step === 5 ? COPY.applyRunning : step === 3 ? (run?.step === "prepare" ? COPY.prepareRunning : COPY.sealRunning) : step === 4 ? COPY.signing : COPY.readyRunning)}

            {stepOf(1) && (
              <div className="pilot-step">
                {heading(STEP_TITLES[0])}
                <fieldset disabled={serverPath !== null}>
                  <legend>{COPY.roleLegend}</legend>
                  <label className="pilot-choice"><input type="radio" name="pilot-role" checked={role === "OPERATOR"} onChange={() => setRole("OPERATOR")} /> {COPY.roleOperator}</label>
                  <label className="pilot-choice"><input type="radio" name="pilot-role" checked={role === "APPROVER"} onChange={() => setRole("APPROVER")} /> {COPY.roleApprover}</label>
                </fieldset>
                <fieldset disabled={serverPath !== null}>
                  <legend>{COPY.pathLegend}</legend>
                  <label className="pilot-choice"><input type="radio" name="pilot-path" checked={pathChoice === "UI"} onChange={() => setPathChoice("UI")} /> {COPY.pathUi}</label>
                  <label className="pilot-choice"><input type="radio" name="pilot-path" checked={pathChoice === "CLI"} onChange={() => setPathChoice("CLI")} /> {COPY.pathCli}</label>
                </fieldset>
                <p>{COPY.pathRule}</p>
                {serverPath === null && <button type="button" onClick={() => void chooseAndGo()}>{COPY.pathContinue}</button>}
                {serverPath === "UI" && (
                  <>
                    <p role="status">{COPY.pathLocked}</p>
                    <button type="button" onClick={() => setStep(role === "APPROVER" ? 4 : 2)}>{COPY.pathContinue}</button>
                    {role === "OPERATOR" && (
                      <p>
                        <button type="button" className="pilot-secondary" onClick={() => setStep(4)}>{COPY.resume}</button>
                        <br /><small>{COPY.resumeWhy}</small>
                      </p>
                    )}
                  </>
                )}
                {locked && (
                  <div className="pilot-cli">
                    <p role="status">{COPY.pathLockedCli}</p>
                    <h3>{COPY.cliTitle}</h3>
                    <p>{COPY.cliNote}</p>
                    <p><small>{COPY.cliWho}</small></p>
                    <ol className="pilot-commands">
                      {CLI_COMMANDS.map((item) => (
                        <li key={item.command}>
                          <strong>{item.who}:</strong> {item.what}<br />
                          <code>{item.command}</code> <CopyButton text={item.command} />
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            )}

            {stepOf(2) && (
              <div className="pilot-step">
                {heading(STEP_TITLES[1])}
                <p>{COPY.readyWhy}</p>
                {serverPath === null && <BlockedNotice state="PATH_NOT_CHOSEN" />}
                {locked && <BlockedNotice state="PATH_IS_CLI" />}
                <label htmlFor="pilot-environment">{COPY.readyEnvironment}</label>
                <select id="pilot-environment" value={environment} disabled={active} onChange={(event) => { setEnvironment(event.target.value as PilotEnvironment); setReadiness(null); }}>
                  {ENVIRONMENTS.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
                <button type="button" disabled={serverPath !== "UI" || active} onClick={() => void begin(() => startPreflight(environment))}>
                  {readiness ? COPY.readyRerun : COPY.readyRun}
                </button>
                {readiness && readiness.environment === environment && (
                  <div aria-live="polite">
                    <p className={readiness.ready ? "pilot-good" : "pilot-error"}><strong>{readiness.ready ? COPY.readyAllGreen : COPY.readySomeRed}</strong></p>
                    <ul className="pilot-checks">
                      {readiness.checks.map((item) => {
                        const words = describeCheck(item, environment);
                        const good = item.ok;
                        return (
                          <li key={item.check} data-ok={good ? "true" : "false"}>
                            <p><span className={good ? "pilot-badge pilot-badge-ok" : "pilot-badge pilot-badge-bad"}>{good ? "Ready" : "Needs attention"}</span> {words.label}</p>
                            {!good && !words.informational && (
                              <>
                                <p><strong>What is wrong:</strong> {words.wrong}</p>
                                <p><strong>How to fix it:</strong> {words.fix}</p>
                              </>
                            )}
                            {level !== "BEGINNER" && (
                              <details className="pilot-details">
                                <summary>{COPY.detailsLabel}</summary>
                                <p>Check: <code>{item.check}</code></p>
                                {item.detail && <p>Detail: {item.detail}</p>}
                              </details>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <p className="pilot-note" role="note">{COPY.readyHeadsUp}</p>
                  </div>
                )}
                {failureFor("preflight") && !readiness?.checks.length && (
                  <Reasoned step="readiness" code={failureFor("preflight")?.result?.code} message={failureFor("preflight")?.result?.message} level={level} transcript={failureFor("preflight")?.transcript} />
                )}
                {!(readiness && readiness.ready && readiness.environment === environment) && serverPath === "UI" && <BlockedNotice state="NOT_READY" />}
                <p className="pilot-actions">
                  <button type="button" className="pilot-secondary" onClick={() => setStep(1)}>{COPY.back}</button>
                  <button type="button" disabled={!(readiness && readiness.ready && readiness.environment === environment)} onClick={() => setStep(3)}>{COPY.readyContinue}</button>
                </p>
              </div>
            )}

            {stepOf(3) && (
              <div className="pilot-step">
                {heading(STEP_TITLES[2])}
                <p>{COPY.sealWhy}</p>
                <p>Environment: <strong>{environment}</strong></p>
                {serverPath === null && <BlockedNotice state="PATH_NOT_CHOSEN" />}
                {locked && <BlockedNotice state="PATH_IS_CLI" />}
                <h4>{COPY.prepareRun}</h4>
                <p>{COPY.prepareWhy}</p>
                <label htmlFor="pilot-project">{COPY.prepareProjectLabel}</label>
                <input id="pilot-project" type="text" autoComplete="off" spellCheck={false} value={projectPath} aria-describedby="pilot-project-help" onChange={(event) => { setProjectPath(event.target.value); setPrepared(null); }} />
                <Help id="pilot-project-help" text={COPY.prepareProjectHelp} example={COPY.egProject} />
                {(needsToolVersion || toolVersion !== "") && (
                  <>
                    <label htmlFor="pilot-tool-version">{COPY.prepareToolVersionLabel}</label>
                    <input id="pilot-tool-version" type="text" autoComplete="off" spellCheck={false} value={toolVersion} aria-describedby="pilot-tool-version-help" onChange={(event) => setToolVersion(event.target.value)} />
                    <Help id="pilot-tool-version-help" text={COPY.prepareToolVersionHelp} example={COPY.egToolVersion} />
                  </>
                )}
                <button type="button" disabled={serverPath !== "UI" || active || projectPath.trim() === ""}
                  onClick={() => void begin(() => startPrepare({ environment, projectPath: projectPath.trim(), ...(toolVersion.trim() ? { awsCliVersion: toolVersion.trim() } : {}) }))}>
                  {COPY.prepareRun}
                </button>
                {failureFor("prepare") && (
                  <>
                    <Reasoned step="get the files ready" code={failureFor("prepare")?.result?.code} message={failureFor("prepare")?.result?.message} level={level} transcript={failureFor("prepare")?.transcript} />
                    {prepareStop?.alternative && <p role="note"><small>{prepareStop.alternative}</small></p>}
                  </>
                )}
                {prepared && prepared.summary.environment === environment && <PreparedSummary prepared={prepared} />}
                <h4>{prepared ? COPY.prepareThen : COPY.prepareOr}</h4>
                <label htmlFor="pilot-request">{COPY.sealRequestLabel}</label>
                <input id="pilot-request" type="text" autoComplete="off" spellCheck={false} value={requestPath} aria-describedby="pilot-request-help" onChange={(event) => setRequestPath(event.target.value)} />
                <Help id="pilot-request-help" text={COPY.sealRequestHelp} example={COPY.egRequest} />
                <label htmlFor="pilot-manifest">{COPY.sealManifestLabel}</label>
                <input id="pilot-manifest" type="text" autoComplete="off" spellCheck={false} value={manifestPath} aria-describedby="pilot-manifest-help" onChange={(event) => setManifestPath(event.target.value)} />
                <Help id="pilot-manifest-help" text={COPY.sealManifestHelp} example={COPY.egManifest} />
                {(requestPath.trim() === "" || manifestPath.trim() === "") && <BlockedNotice state="FIELDS_MISSING" />}
                <button type="button" disabled={serverPath !== "UI" || active || requestPath.trim() === "" || manifestPath.trim() === ""}
                  onClick={() => void begin(() => startSeal({ environment, requestPath: requestPath.trim(), manifestPath: manifestPath.trim() }))}>
                  {COPY.sealRun}
                </button>
                {failureFor("seal") && (
                  <Reasoned step="prepare" code={failureFor("seal")?.result?.code} message={failureFor("seal")?.result?.message} level={level} transcript={failureFor("seal")?.transcript} />
                )}
                {review && sealedPath && run?.step === "seal" && run.result?.exit === 0 && (
                  <div role="status" className="pilot-good">
                    <p><strong>{COPY.sealDone}</strong> {COPY.sealNext}</p>
                    <p>{COPY.sealKeep}</p>
                    <ul>
                      <li>{COPY.applySealedLabel}: <code>{sealedPath}</code> <CopyButton text={sealedPath} /></li>
                      <li>{COPY.approverBundleLabel}: <code>{bundlePath}</code> <CopyButton text={bundlePath} /></li>
                    </ul>
                    <button type="button" onClick={() => setStep(4)}>{COPY.next}: {STEP_TITLES[3]}</button>
                  </div>
                )}
                <p className="pilot-actions"><button type="button" className="pilot-secondary" onClick={() => setStep(2)}>{COPY.back}</button></p>
              </div>
            )}

            {stepOf(4) && (
              <div className="pilot-step">
                {heading(STEP_TITLES[3])}
                <p>{COPY.reviewWhy}</p>
                {serverPath === null && <BlockedNotice state="PATH_NOT_CHOSEN" />}
                {locked && <BlockedNotice state="PATH_IS_CLI" />}
                {(role === "APPROVER" || !review) && (
                  <>
                    <label htmlFor="pilot-bundle">{COPY.approverBundleLabel}</label>
                    <input id="pilot-bundle" type="text" autoComplete="off" spellCheck={false} value={bundlePath} aria-describedby="pilot-bundle-help" onChange={(event) => setBundlePath(event.target.value)} />
                    <Help id="pilot-bundle-help" text={COPY.approverBundleHelp} example={COPY.egBundle} />
                    <button type="button" disabled={serverPath !== "UI" || bundlePath.trim() === ""} onClick={async () => {
                      const reply = await loadReview(bundlePath.trim());
                      if (!reply.ok) { take(reply as PilotReply); return; }
                      if (reply.body.ok) { setReview(reply.body.summary); setReviewError(null); setEnvironment(reply.body.summary.environment); }
                      else { setReview(null); setReviewError({ code: reply.body.code, message: reply.body.message }); }
                    }}>{COPY.approverLoad}</button>
                    {reviewError && <Reasoned step="review" code={reviewError.code} message={reviewError.message} level={level} />}
                  </>
                )}
                {review && <ChangeList review={review} />}
                {!review && role === "OPERATOR" && <BlockedNotice state="NOTHING_PREPARED" />}
                {!review && role === "APPROVER" && <BlockedNotice state="REVIEW_NOT_LOADED" />}

                {role === "OPERATOR" && review && (
                  <div className="pilot-share">
                    <h3>Approvals</h3>
                    <p>{COPY.reviewNeeded}</p>
                    {bundlePath && <p>{COPY.reviewOperatorShare}<br /><code>{bundlePath}</code> <CopyButton text={bundlePath} /></p>}
                    <p>{COPY.reviewOperatorAsk}</p>
                    <label htmlFor="pilot-approvals">{COPY.reviewApprovalsLabel}</label>
                    <textarea id="pilot-approvals" rows={3} spellCheck={false} value={approvalsText} aria-describedby="pilot-approvals-help" onChange={(event) => setApprovalsText(event.target.value)} />
                    <Help id="pilot-approvals-help" text={COPY.reviewApprovalsHelp} example={COPY.egApproval} />
                    {approvalPaths.length === 0 && <BlockedNotice state="NO_APPROVALS_YET" />}
                    <button type="button" disabled={approvalPaths.length === 0} onClick={() => setStep(5)}>{COPY.reviewContinue}</button>
                  </div>
                )}

                {role === "APPROVER" && review && (
                  <div className="pilot-sign">
                    <h3>Your signature</h3>
                    <label htmlFor="pilot-key">{COPY.approverKeyLabel}</label>
                    <input id="pilot-key" type="text" autoComplete="off" spellCheck={false} value={keyPath} aria-describedby="pilot-key-help" onChange={(event) => setKeyPath(event.target.value)} />
                    <Help id="pilot-key-help" text={COPY.approverKeyHelp} example={COPY.egKey} />
                    <label htmlFor="pilot-approver">{COPY.approverNameLabel}</label>
                    <input id="pilot-approver" type="text" autoComplete="off" spellCheck={false} value={approverId} aria-describedby="pilot-approver-help" onChange={(event) => setApproverId(event.target.value)} />
                    <Help id="pilot-approver-help" text={COPY.approverNameHelp} example={COPY.egName} />
                    {(keyPath.trim() === "" || approverId.trim() === "") && <BlockedNotice state="FIELDS_MISSING" />}
                    <button type="button" disabled={serverPath !== "UI" || active || keyPath.trim() === "" || approverId.trim() === ""}
                      onClick={() => void begin(() => startApprove({ bundlePath: bundlePath.trim(), keyPath: keyPath.trim(), approverId: approverId.trim() }))}>
                      {COPY.approverSign}
                    </button>
                    {failureFor("approve") && (
                      <Reasoned step="approve" code={failureFor("approve")?.result?.code} message={failureFor("approve")?.result?.message} level={level} transcript={failureFor("approve")?.transcript} />
                    )}
                    {signedPath && run?.step === "approve" && run.result?.exit === 0 && (
                      <div role="status" className="pilot-good">
                        <p><strong>{COPY.approverSigned}</strong> {COPY.approverSendBack}</p>
                        <p><code>{signedPath}</code> <CopyButton text={signedPath} /></p>
                      </div>
                    )}
                  </div>
                )}
                <p className="pilot-actions">
                  <button type="button" className="pilot-secondary" onClick={() => setStep(role === "APPROVER" ? 1 : 3)}>{COPY.back}</button>
                </p>
              </div>
            )}

            {stepOf(5) && (
              <div className="pilot-step">
                {heading(STEP_TITLES[4])}
                <p>{COPY.applyWhy}</p>
                {serverPath === null && <BlockedNotice state="PATH_NOT_CHOSEN" />}
                {locked && <BlockedNotice state="PATH_IS_CLI" />}
                {review && <p>You are about to apply: {describeCounts(review.counts).join("; ")} in <strong>{review.environment}</strong>.</p>}
                <label htmlFor="pilot-apply-request">{COPY.sealRequestLabel}</label>
                <input id="pilot-apply-request" type="text" autoComplete="off" spellCheck={false} value={requestPath} onChange={(event) => setRequestPath(event.target.value)} />
                <label htmlFor="pilot-apply-manifest">{COPY.sealManifestLabel}</label>
                <input id="pilot-apply-manifest" type="text" autoComplete="off" spellCheck={false} value={manifestPath} onChange={(event) => setManifestPath(event.target.value)} />
                <label htmlFor="pilot-apply-sealed">{COPY.applySealedLabel}</label>
                <input id="pilot-apply-sealed" type="text" autoComplete="off" spellCheck={false} value={sealedPath} aria-describedby="pilot-apply-sealed-help" onChange={(event) => setSealedPath(event.target.value)} />
                <Help id="pilot-apply-sealed-help" text={COPY.applySealedHelp} example={COPY.egSealed} />
                <label htmlFor="pilot-apply-approvals">{COPY.reviewApprovalsLabel}</label>
                <textarea id="pilot-apply-approvals" rows={3} spellCheck={false} value={approvalsText} onChange={(event) => setApprovalsText(event.target.value)} />
                {(requestPath.trim() === "" || manifestPath.trim() === "" || sealedPath.trim() === "") && <BlockedNotice state="FIELDS_MISSING" />}
                {approvalPaths.length === 0 && <BlockedNotice state="NO_APPROVALS_YET" />}
                <button type="button"
                  disabled={serverPath !== "UI" || active || requestPath.trim() === "" || manifestPath.trim() === "" || sealedPath.trim() === "" || approvalPaths.length === 0}
                  onClick={() => void begin(() => startApply({ environment: review?.environment ?? environment, requestPath: requestPath.trim(), manifestPath: manifestPath.trim(), sealedPath: sealedPath.trim(), approvalPaths }))}>
                  {COPY.applyRun}
                </button>
                {failureFor("apply") && step === 5 && (
                  <Reasoned step="apply" code={failureFor("apply")?.result?.code} message={failureFor("apply")?.result?.message} level={level} transcript={failureFor("apply")?.transcript} />
                )}
                <p className="pilot-actions"><button type="button" className="pilot-secondary" disabled={active} onClick={() => setStep(4)}>{COPY.back}</button></p>
              </div>
            )}

            {stepOf(6) && (
              <div className="pilot-step">
                {heading(STEP_TITLES[5])}
                {!finalResult && <BlockedNotice state="NOTHING_PREPARED" />}
                {finalResult && (() => {
                  const kind = classifyResult(finalResult.step, finalResult.result);
                  const words = RESULT_COPY[kind];
                  return (
                    <div className={"pilot-result pilot-result-" + words.tone} role="status" aria-live="polite" data-result={kind}>
                      <h3>{words.headline}</h3>
                      <p>{words.what}</p>
                      {kind !== "APPLIED" && <Reasoned step="apply" code={finalResult.result.code} message={finalResult.result.message} level={level} transcript={run?.transcript} />}
                      <h4>What to do now</h4>
                      <ul>{words.next.map((line) => <li key={line}>{line}</li>)}</ul>
                    </div>
                  );
                })()}
                <p className="pilot-actions">
                  {finalResult && classifyResult(finalResult.step, finalResult.result) !== "NEEDS_REVIEW" && classifyResult(finalResult.step, finalResult.result) !== "APPLIED" && (
                    <button type="button" onClick={() => setStep(role === "APPROVER" ? 4 : 5)}>{COPY.tryAgain}</button>
                  )}
                  <button type="button" className="pilot-secondary" disabled={active} onClick={() => void reset()}>{COPY.newChange}</button>
                </p>
              </div>
            )}

            {level === "EXPERT" && step >= 2 && <p className="pilot-equivalent"><small>Command line equivalent of this step: <code>{CLI_COMMANDS[Math.min(step - 2, CLI_COMMANDS.length - 1)].command}</code></small></p>}
          </>
        )}
      </div>
      {dialog && (
        <PilotDialog
          key={dialog.id}
          copy={dialogCopy(dialog.kind, dialogEnvironment)}
          phrase={dialog.phrase}
          busy={false}
          onSubmit={(typed) => void submitAnswer(typed)}
          onCancel={() => void cancelQuestion()}
        />
      )}
    </section>
  );
}
