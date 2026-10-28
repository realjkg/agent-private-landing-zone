import { forwardRef, useState } from "react";

import type { DeploymentPath, EnvironmentDecision, PathParty, PathsReport } from "./pilot-api";
import { badgeOf, checkedTime, environmentReady, firstSentence, orderByReadiness, orderEnvironments, tierOf } from "./readiness-order";

// The "Deployment paths" panel (owner decision E5): every cloud and build path, readiest first, from the release records and the
// readiness checks already run. Read-only: a row only opens to show what that path still needs. It has no button that starts,
// selects or enables anything; the path in the owner's reviewed rules stays the only one that can run, through the steps below.

export type PathsLoad = { status: "loading" } | { status: "error" } | { status: "ready"; report: PathsReport };

const CLOUD_TITLES: Readonly<Record<string, string>> = { AWS: "AWS", AZURE: "Azure", GCP: "Google Cloud (GCP)" };
const PARTY_WORDS: Readonly<Record<PathParty, string>> = {
  OWNER: "the owner", OPERATOR: "the operator", SEQUENCED: "another path going live first", ENGINEERING: "engineering", QUALIFICATION: "qualification",
  RELEASE_SCOPE: "the release scope", UNKNOWN: "records that cannot be read",
};
const JOURNEY_WORDS: Readonly<Record<string, string>> = {
  LIVE_PASS: "Proven on the real cloud", SYNTHETIC_PASS: "Every step tested with stand-ins only (synthetic, not live)",
  BLOCKED: "Steps blocked", NOT_IMPLEMENTED: "Not built",
};
const LIVE_WORDS: Readonly<Record<string, string>> = { LIVE_PASS: "Done", BLOCKED: "Not run yet", NOT_IMPLEMENTED: "Not possible yet" };
const decisionWord = (value: boolean | null): string => value === true ? "Yes" : value === false ? "No" : "Not checked yet";
/** Ready is always shown with the time of the check that said so: it is the last check's answer, not a live one. */
const readyWords = (d: EnvironmentDecision): string => d.ready === true ? "Yes, at the last check" + (checkedTime(d.checkedAt) ? " (" + checkedTime(d.checkedAt) + ")" : "") : decisionWord(d.ready);

/** Groups in the order their readiest path appears, so the first group holds the first path. */
function groupsOf(paths: readonly DeploymentPath[]): { cloud: string; paths: DeploymentPath[] }[] {
  const groups: { cloud: string; paths: DeploymentPath[] }[] = [];
  for (const path of orderByReadiness(paths)) {
    const group = groups.find((g) => g.cloud === path.cloud);
    if (group) group.paths.push(path); else groups.push({ cloud: path.cloud, paths: [path] });
  }
  return groups;
}

function EnvironmentDecisions(props: { decisions: readonly EnvironmentDecision[] }) {
  const order = orderEnvironments(props.decisions).map((choice) => choice.environment);
  const sorted = order.map((name) => props.decisions.find((d) => d.environment === name)).filter((d): d is EnvironmentDecision => d !== undefined);
  return (
    <table className="pilot-table paths-decisions">
      <caption className="pilot-caption">Per environment, from the readiness checks run in step 2.</caption>
      <thead><tr><th scope="col">Environment</th><th scope="col">Authorized</th><th scope="col">Ready</th><th scope="col">Approval rule</th><th scope="col">Status</th></tr></thead>
      <tbody>
        {sorted.map((d) => (
          <tr key={d.environment} data-environment={d.environment}>
            <th scope="row">{d.environment}</th>
            <td>{decisionWord(d.authorized)}</td>
            <td>{readyWords(d)}{d.ready === false && d.notReady.length > 0 ? " (" + d.notReady.length + " to fix)" : ""}</td>
            <td>{d.approved ? "Rule set: each change needs " + d.requiredApprovals + " approval(s)" : "No rule"}</td>
            <td>{environmentReady(d) ? "Ready" : d.authorized ? "Waiting on inputs" : "Not enabled"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PathRow(props: { path: DeploymentPath }) {
  const { path } = props;
  const [open, setOpen] = useState(false);
  const { tier } = tierOf(path);
  const id = "path-" + path.cloud.toLowerCase() + "-" + path.engine.toLowerCase();
  const first = path.blockers[0];
  const readyIn = (path.decisions ?? []).find(environmentReady);
  return (
    <li className="paths-row" data-tier={tier} data-path={path.cloud + "/" + path.engine}>
      <button type="button" className="paths-toggle" aria-expanded={open} aria-controls={id + "-details"} onClick={() => setOpen(!open)}>
        <span className="paths-label">{path.label}</span>{" "}
        <span className={"pilot-badge paths-badge"} data-tier={tier}>{badgeOf(path)}</span>
        {path.isContractPath && <span className="pilot-badge paths-badge">The reviewed path</span>}
      </button>
      <p className="paths-reason">{tier === 1 && readyIn ? "Authorized and ready in " + readyIn.environment + " at the last check" +
          (checkedTime(readyIn.checkedAt) ? " (" + checkedTime(readyIn.checkedAt) + ")" : "") + ". Each change still needs " + readyIn.requiredApprovals + " approval(s) before it can run."
        : first ? <>Waits on {PARTY_WORDS[first.party] ?? first.party}: {firstSentence(first.text)}</> : "No blocker is recorded, but readiness has not been confirmed."}</p>
      <div id={id + "-details"} hidden={!open} className="paths-details">
        <dl className="pilot-facts">
          <dt>Steps</dt><dd>{JOURNEY_WORDS[path.journeyStatus] ?? path.journeyStatus}</dd>
          <dt>Live run</dt><dd>{LIVE_WORDS[path.liveStatus] ?? path.liveStatus}</dd>
          <dt>In this release</dt><dd>{path.inRelease ? "Yes" : "No"}</dd>
        </dl>
        {path.isContractPath && path.decisions && <EnvironmentDecisions decisions={path.decisions} />}
        {path.blockers.length > 0 && (
          <>
            <p>What it still needs:</p>
            <ul className="paths-blockers">
              {path.blockers.map((b) => <li key={b.text}><strong>{PARTY_WORDS[b.party] ?? b.party}:</strong> {b.text}</li>)}
            </ul>
          </>
        )}
      </div>
    </li>
  );
}

/** Its own panel above the pilot wizard. The wizard makes it inert, with the rest of the page, while a confirmation dialog is open. */
export const DeploymentPaths = forwardRef<HTMLElement, { load: PathsLoad }>(function DeploymentPaths(props, ref) {
  const { load } = props;
  return (
    <section ref={ref} className="panel paths" aria-labelledby="paths-title" data-testid="deployment-paths">
      <h2 id="paths-title">Deployment paths</h2>
      <p>Paths with readiness are listed first. This list is for information: open a path to see what it still needs. Only the
        path in the owner's reviewed rules can run, and only through the steps below.</p>
      {load.status === "loading" && <p role="status">Loading deployment paths…</p>}
      {load.status === "error" && <p role="note" className="paths-error">The list of deployment paths could not be loaded. The steps below still work.</p>}
      {load.status === "ready" && load.report.paths.length === 0 && <p role="note">No deployment paths are recorded.</p>}
      {load.status === "ready" && load.report.paths.length > 0 && (
        <>
          <p role="note" className="paths-contract" data-contract={load.report.contract.state}>{
            load.report.contract.state === "ENABLED" ? "The path marked \"The reviewed path\" is the one the owner's reviewed rules allow."
              : load.report.contract.state === "DISABLED" ? "The owner's reviewed rules are not in place, so no path can run."
                : "The owner's reviewed rules could not be read, so readiness is unknown."}</p>
          {load.report.contract.state === "ENABLED" && load.report.contract.killSwitch && (
            <p role="note" className="paths-stop">The emergency stop is on, so no environment is shown as ready.</p>
          )}
          {groupsOf(load.report.paths).map((group) => (
            <fieldset key={group.cloud} className="paths-group" data-cloud={group.cloud}>
              <legend>{CLOUD_TITLES[group.cloud] ?? group.cloud}</legend>
              <ul className="paths-list">{group.paths.map((path) => <PathRow key={path.cloud + "/" + path.engine} path={path} />)}</ul>
            </fieldset>
          ))}
        </>
      )}
    </section>
  );
});
