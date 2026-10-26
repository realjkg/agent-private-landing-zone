import { useEffect, useRef, useState } from "react";

import type { ExperienceLevel } from "../../experience-level.js";
import {
  startCleanup, startObserve, startProposeCleanup, startVerifyCleanup,
  type CleanupSummary, type LeftoversData, type ObservationData, type PilotEnvironment, type PilotReply, type PilotRun, type RunResult,
} from "./pilot-api";
import { BlockedNotice, CopyButton, Reasoned } from "./PilotWizard";
import { CLEANUP_RESULT_COPY, COPY, classifyResult, dispositionWord, originWord, ownershipWord, verificationWord } from "./pilot-copy";

/**
 * Step 7 of the pilot wizard (docs/act-pilot-walkthrough.md, "Check and clean up"): look at what the change created,
 * write the cleanup proposal, collect cleanup approvals, remove exactly the listed things, and check that they are gone.
 * Every call goes through the console's pilot channel to the same commands the terminal runs; this file draws what came
 * back, in plain words. Looking and checking are read-only and can be repeated; a removal already done is never done twice
 * (the console refuses it), so a reload or a reconnect is safe.
 */
export type CleanupStepProps = {
  level: ExperienceLevel;
  environment: PilotEnvironment;
  serverPath: "UI" | "CLI" | null;
  active: boolean;
  run: PilotRun | null;
  sealedPath: string;
  setSealedPath: (value: string) => void;
  requestPath: string;
  manifestPath: string;
  begin: (action: () => Promise<PilotReply>) => Promise<void>;
};

const idOf = (identifier: string | null): string => identifier ?? "(no identifier recorded)";

/** The cleanup proposal as a person reads it: what goes, what is already gone, what stays and why, and the risks. */
export function CleanupList(props: { cleanup: CleanupSummary }) {
  const { cleanup } = props;
  return (
    <div className="pilot-review" data-cleanup-proposal={cleanup.shortId}>
      <dl className="pilot-facts">
        <dt>Environment</dt><dd>{cleanup.environment}</dd>
        <dt>Place</dt><dd><code>{cleanup.target.account} | {cleanup.target.backend} | {cleanup.target.workspace}</code></dd>
        <dt>Proposal ID (first 12 characters)</dt><dd><code>{cleanup.shortId}</code></dd>
        <dt>Change it cleans up</dt><dd><code>{cleanup.artifactShortId}</code></dd>
        <dt>App version that prepared it</dt><dd><code>{cleanup.sourceCommit.slice(0, 12)}</code></dd>
        <dt>{COPY.proposeApprovalsNeeded}</dt><dd>{cleanup.requiredApprovals}</dd>
      </dl>
      <h3>{COPY.proposeDeletes} ({cleanup.deletes.length})</h3>
      {cleanup.deletes.length === 0 ? <p>{COPY.proposeDeletesNone}</p> : (
        <table className="pilot-table">
          <caption className="pilot-caption">Exactly these things, and nothing else, may be removed.</caption>
          <thead><tr><th scope="col">Name in the project</th><th scope="col">Kind</th><th scope="col">Identifier in the cloud</th><th scope="col">Last check</th></tr></thead>
          <tbody>
            {cleanup.deletes.map((item) => (
              <tr key={item.address} data-delete={item.address}>
                <td><code>{item.address}</code></td><td><code>{item.type}</code></td><td><code>{idOf(item.identifier)}</code></td>
                <td>{verificationWord(item.observed)}{item.risk && <><br /><small role="note">Risk: {item.risk}</small></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cleanup.alreadyAbsent.length > 0 && (
        <>
          <h3>{COPY.proposeAbsent} ({cleanup.alreadyAbsent.length})</h3>
          <ul>{cleanup.alreadyAbsent.map((item) => <li key={item.address}><code>{item.address}</code> <code>{idOf(item.identifier)}</code></li>)}</ul>
        </>
      )}
      <h3>{COPY.proposeKept} ({cleanup.excluded.length})</h3>
      {cleanup.excluded.length === 0 ? <p>Nothing else is in the project's records.</p> : (
        <ul>{cleanup.excluded.map((item) => <li key={item.address} data-kept={item.address}><code>{item.address}</code> ({ownershipWord(item.ownership)}): {item.reason}</li>)}</ul>
      )}
      <h3>{COPY.proposeRisks}</h3>
      <ul>{cleanup.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul>
    </div>
  );
}

/** What the independent check found for each thing. */
function ObservationTable(props: { observation: ObservationData }) {
  const { observation } = props;
  const words = observation.verdict === "VERIFIED" ? COPY.observeVerdictGood : observation.verdict === "PARTIAL" ? COPY.observeVerdictPartial
    : observation.verdict === "FAILED" ? COPY.observeVerdictBad : COPY.observeVerdictUnsure;
  return (
    <div role="status" aria-live="polite" data-observation={observation.verdict}>
      <p><strong>{COPY.observeDone}</strong> {words}</p>
      <p role="note"><small>{COPY.observeSynthetic}</small></p>
      <table className="pilot-table">
        <caption className="pilot-caption">{COPY.observeColumns}</caption>
        <thead><tr><th scope="col">Name in the project</th><th scope="col">Kind</th><th scope="col">Identifier in the cloud</th><th scope="col">Origin</th><th scope="col">What the check found</th></tr></thead>
        <tbody>
          {observation.resources.map((item) => (
            <tr key={item.address} data-observed={item.result}>
              <td><code>{item.address}</code></td><td><code>{item.type}</code></td><td><code>{idOf(item.identifier)}</code></td><td>{originWord(item.origin)}</td>
              <td>{verificationWord(item.result)}{item.reason && <> <details className="pilot-details"><summary>{COPY.detailsLabel}</summary><p>Reference: <code>{item.reason}</code></p></details></>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {observation.missingFromState.length > 0 && <p role="alert">Planned but never recorded: {observation.missingFromState.map((address) => <code key={address}>{address} </code>)}</p>}
      {observation.unexpected.length > 0 && <p role="alert">Unexpected, carrying this change's label: {observation.unexpected.map((id) => <code key={id}>{id} </code>)}</p>}
    </div>
  );
}

/** What the leftover check found for each thing on the proposal, and whether the cleanup is complete. */
function LeftoversTable(props: { leftovers: LeftoversData }) {
  const { leftovers } = props;
  const complete = leftovers.disposition === "COMPLETE";
  const known = leftovers.disposition === "KNOWN_ADDRESSES_CONFIRMED";
  return (
    <div role="status" aria-live="polite" className={complete ? "pilot-result pilot-result-good" : "pilot-result pilot-result-caution"} data-leftovers={leftovers.disposition}>
      <h3>{complete ? COPY.verifyComplete : known ? COPY.verifyKnownConfirmed : COPY.verifyIncomplete}</h3>
      <p><strong>{COPY.verifyNextLabel}</strong> {leftovers.nextAction}</p>
      {leftovers.sweep === "NOT_AVAILABLE" && <p role="note"><small>{COPY.verifyNotSearched}</small></p>}
      <p role="note"><small>{COPY.observeSynthetic}</small></p>
      <table className="pilot-table">
        <thead><tr><th scope="col">Name in the project</th><th scope="col">Identifier in the cloud</th><th scope="col">Now</th></tr></thead>
        <tbody>
          {leftovers.resources.map((item) => (
            <tr key={item.address + "|" + (item.identifier ?? "")} data-disposition={item.disposition}>
              <td><code>{item.address}</code></td><td><code>{idOf(item.identifier)}</code></td>
              <td>{dispositionWord(item.disposition)}{item.reason && <>: {item.reason}</>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CleanupStep(props: CleanupStepProps) {
  const { level, environment, serverPath, active, run, sealedPath, setSealedPath, requestPath, manifestPath, begin } = props;
  const [observation, setObservation] = useState<ObservationData | null>(null);
  const [cleanup, setCleanup] = useState<CleanupSummary | null>(null);
  const [proposalPath, setProposalPath] = useState("");
  const [approvalsText, setApprovalsText] = useState("");
  const [removal, setRemoval] = useState<RunResult | null>(null);
  const [leftovers, setLeftovers] = useState<LeftoversData | null>(null);
  const handled = useRef("");

  // What each finished step leaves behind. A run is handled once; a failed run leaves the earlier result on screen with its reason.
  useEffect(() => {
    if (!run || run.status !== "DONE" || !run.result || handled.current === run.id) return;
    handled.current = run.id;
    const result = run.result;
    if (run.step === "observe" && result.exit === 0) setObservation(result.data as ObservationData);
    else if (run.step === "propose-cleanup" && result.exit === 0) {
      const data = result.data as { path?: string } | undefined;
      if (result.cleanup) setCleanup(result.cleanup);
      if (typeof data?.path === "string") setProposalPath(data.path);
    } else if (run.step === "cleanup") setRemoval(result);
    else if (run.step === "verify-cleanup" && result.exit === 0) setLeftovers(result.data as LeftoversData);
  }, [run]);

  const locked = serverPath === "CLI";
  const off = serverPath !== "UI" || active;
  const approvalPaths = approvalsText.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const failureFor = (step: string) => run?.status === "DONE" && run.step === step && run.result && run.result.exit !== 0 ? run : null;
  const removalKind = removal ? classifyResult("cleanup", removal) : null;
  const removalWords = removalKind ? CLEANUP_RESULT_COPY[removalKind] : null;

  return (
    <div className="pilot-step" data-step="cleanup">
      <p>{COPY.cleanupWhy}</p>
      <p className="pilot-safety">{COPY.cleanupSafety}</p>
      <p><small>{COPY.cleanupReconnect}</small></p>
      {serverPath === null && <BlockedNotice state="PATH_NOT_CHOSEN" />}
      {locked && <BlockedNotice state="PATH_IS_CLI" />}

      <h4>{COPY.observeRun}</h4>
      <label htmlFor="pilot-cleanup-sealed">{COPY.cleanupSealedLabel}</label>
      <input id="pilot-cleanup-sealed" type="text" autoComplete="off" spellCheck={false} value={sealedPath} aria-describedby="pilot-cleanup-sealed-help" onChange={(event) => setSealedPath(event.target.value)} />
      <p id="pilot-cleanup-sealed-help"><small>{COPY.cleanupSealedHelp} Example: <code>{COPY.egSealed}</code></small></p>
      {sealedPath.trim() === "" && <BlockedNotice state="FIELDS_MISSING" />}
      <button type="button" disabled={off || sealedPath.trim() === ""} onClick={() => void begin(() => startObserve(sealedPath.trim()))}>
        {observation ? COPY.observeRerun : COPY.observeRun}
      </button>
      {failureFor("observe") && <Reasoned step="look at what was created" code={failureFor("observe")?.result?.code} message={failureFor("observe")?.result?.message} level={level} transcript={failureFor("observe")?.transcript} />}
      {observation && <ObservationTable observation={observation} />}

      <h4>{COPY.proposeRun}</h4>
      <button type="button" disabled={off || sealedPath.trim() === "" || !observation} onClick={() => void begin(() => startProposeCleanup(sealedPath.trim()))}>{COPY.proposeRun}</button>
      {!observation && <p><small>Look at what was created first; the proposal is written from that look.</small></p>}
      {failureFor("propose-cleanup") && <Reasoned step="write the cleanup proposal" code={failureFor("propose-cleanup")?.result?.code} message={failureFor("propose-cleanup")?.result?.message} level={level} transcript={failureFor("propose-cleanup")?.transcript} />}
      {cleanup && (
        <div role="status" className="pilot-good">
          <p><strong>{COPY.proposeDone}</strong> {COPY.proposeKeep}</p>
          <p>{COPY.cleanupProposalLabel}: <code>{proposalPath}</code> <CopyButton text={proposalPath} /></p>
          <CleanupList cleanup={cleanup} />
          <div className="pilot-share">
            <h3>Approvals</h3>
            <p>{COPY.proposeSend}</p>
            <p>{COPY.proposeAsk}</p>
          </div>
        </div>
      )}

      <h4>{COPY.cleanupRun}</h4>
      <label htmlFor="pilot-cleanup-proposal">{COPY.cleanupProposalLabel}</label>
      <input id="pilot-cleanup-proposal" type="text" autoComplete="off" spellCheck={false} value={proposalPath} aria-describedby="pilot-cleanup-proposal-help" onChange={(event) => setProposalPath(event.target.value)} />
      <p id="pilot-cleanup-proposal-help"><small>{COPY.cleanupProposalHelp} Example: <code>{COPY.egProposal}</code></small></p>
      <label htmlFor="pilot-cleanup-approvals">{COPY.cleanupApprovalsLabel}</label>
      <textarea id="pilot-cleanup-approvals" rows={3} spellCheck={false} value={approvalsText} aria-describedby="pilot-cleanup-approvals-help" onChange={(event) => setApprovalsText(event.target.value)} />
      <p id="pilot-cleanup-approvals-help"><small>{COPY.cleanupApprovalsHelp} Example: <code>{COPY.egCleanupApproval}</code></small></p>
      {approvalPaths.length === 0 && <BlockedNotice state="NO_APPROVALS_YET" />}
      {(requestPath.trim() === "" || manifestPath.trim() === "") && <p role="note"><small>{COPY.cleanupNeedsApplyFiles}</small></p>}
      {sealedPath.trim() === "" && <p role="note"><small>{COPY.cleanupNeedsSealed}</small></p>}
      <button type="button" disabled={off || proposalPath.trim() === "" || approvalPaths.length === 0 || requestPath.trim() === "" || manifestPath.trim() === "" || sealedPath.trim() === ""}
        onClick={() => void begin(() => startCleanup({ environment, requestPath: requestPath.trim(), manifestPath: manifestPath.trim(), sealedPath: sealedPath.trim(), proposalPath: proposalPath.trim(), approvalPaths }))}>
        {COPY.cleanupRun}
      </button>
      {removal && removalWords && (
        <div className={"pilot-result pilot-result-" + removalWords.tone} role="status" aria-live="polite" data-result={removalKind}>
          <h3>{removalWords.headline}</h3>
          <p>{removalWords.what}</p>
          {removalKind !== "APPLIED" && <Reasoned step="remove the listed things" code={removal.code} message={removal.message} level={level} transcript={run?.transcript} />}
          <h4>What to do now</h4>
          <ul>{removalWords.next.map((line) => <li key={line}>{line}</li>)}</ul>
          <p role="note"><small>{COPY.observeSynthetic}</small></p>
        </div>
      )}

      <h4>{COPY.verifyRun}</h4>
      <button type="button" disabled={off || proposalPath.trim() === ""} onClick={() => void begin(() => startVerifyCleanup(proposalPath.trim()))}>{leftovers ? COPY.verifyRerun : COPY.verifyRun}</button>
      {failureFor("verify-cleanup") && <Reasoned step="check that everything is gone" code={failureFor("verify-cleanup")?.result?.code} message={failureFor("verify-cleanup")?.result?.message} level={level} transcript={failureFor("verify-cleanup")?.transcript} />}
      {leftovers && <LeftoversTable leftovers={leftovers} />}
    </div>
  );
}
