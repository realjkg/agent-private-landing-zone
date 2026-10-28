// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DeploymentContext } from "../src/operator-ui/app/components/DeploymentContext";
import { DeploymentPaths } from "../src/operator-ui/app/pilot/DeploymentPaths";
import PilotWizard from "../src/operator-ui/app/pilot/PilotWizard";
import { forgetPilotToken, setPilotToken, type DeploymentPath, type EnvironmentDecision, type PathsReport } from "../src/operator-ui/app/pilot/pilot-api";
import { COPY, STEP_TITLES } from "../src/operator-ui/app/pilot/pilot-copy";

// The readiness-first selections (owner decision E5): the Deployment paths panel, the wizard's environment order, and the planning
// view's order. A scripted stand-in answers the page with fixture records (SYNTHETIC); the server side is test/pilot-paths.test.ts.

const TOKEN = "tok-" + "f0e1d2c3b4a5".repeat(5);
const decision = (environment: EnvironmentDecision["environment"], over: Partial<EnvironmentDecision> = {}): EnvironmentDecision => ({
  environment, authorized: true, operations: ["APPLY", "CLEANUP"], ready: null, notReady: [], approved: true, requiredApprovals: 1, checkedAt: null, ...over,
});
const row = (cloud: string, engine: string, label: string, over: Partial<DeploymentPath> = {}): DeploymentPath => ({
  cloud, engine, label, inRelease: true, liveStatus: "BLOCKED", journeyStatus: "SYNTHETIC_PASS", implemented: true, actGate: null,
  blockers: [{ party: "OWNER", source: "GATE", text: "A person runs one supervised DEV apply. Then more words." }], isContractPath: false, ...over,
});
const CHECKED = "2026-10-28T10:05:00.000Z";
function report(environments: EnvironmentDecision[] = [decision("DEV", { ready: true, checkedAt: CHECKED }), decision("QA"), decision("PROD", { requiredApprovals: 2 })]): PathsReport {
  return {
    label: "RELEASE_RECORDS",
    contract: { state: "ENABLED", provider: "AZURE", engine: "TERRAFORM", contractSha256: "c".repeat(64), killSwitch: false },
    environments,
    paths: [
      row("AWS", "TERRAFORM", "AWS · Terraform", { blockers: [{ party: "OWNER", source: "JOURNEY", text: "Owner supervision and inputs. More." }, { party: "OWNER", source: "GATE", text: "Run it live." }] }),
      row("AWS", "CDK", "AWS · CDK", { blockers: [{ party: "ENGINEERING", source: "GATE", text: "Qualify the three adapters. Then run it." }] }),
      row("AZURE", "TERRAFORM", "Azure · Terraform", { isContractPath: true, decisions: environments }),
      row("AZURE", "BICEP", "Azure · Bicep", { implemented: false, journeyStatus: "BLOCKED", blockers: [{ party: "ENGINEERING", source: "JOURNEY", text: "No console test drives it yet." }] }),
      row("GCP", "TERRAFORM", "GCP · Terraform", { inRelease: false, journeyStatus: "NOT_IMPLEMENTED", liveStatus: "NOT_IMPLEMENTED", blockers: [{ party: "RELEASE_SCOPE", source: "SCOPE", text: "Not in this release: it is not one of the release's ACT paths." }] }),
      row("GCP", "NATIVE_API", "GCP · API-native", { inRelease: false, journeyStatus: "NOT_IMPLEMENTED", liveStatus: "NOT_IMPLEMENTED", blockers: [{ party: "RELEASE_SCOPE", source: "SCOPE", text: "Not in this release: it is not one of the release's ACT paths." }] }),
    ],
  };
}

type Call = { url: string; method: string };
type Fake = { run: unknown; pathsReplies: { status: number; body: unknown }[]; onPreflight?: (environment: string) => void };
function install(paths: { status: number; body: unknown }, fake: Fake = { run: null, pathsReplies: [] }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const token = ((init.headers ?? {}) as Record<string, string>)["X-ALZ-Pilot-Token"];
    calls.push({ url, method: init.method ?? "GET" });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (token !== TOKEN) return url === "/pilot/state" ? json({ unlocked: false }) : json({ error: "PILOT_TOKEN_REQUIRED", message: "no" }, 401);
    const state = () => ({ unlocked: true, path: "UI", busy: false, run: fake.run });
    if (url === "/pilot/paths") { const next = fake.pathsReplies.shift() ?? paths; return json(next.body, next.status); }
    if (url === "/pilot/state") return json(state());
    if (url === "/pilot/preflight") { fake.onPreflight?.(JSON.parse(String(init.body)).environment); return json(state(), 202); }
    return json({ error: "NOT_FOUND", message: "no" }, 404);
  }));
  return calls;
}

beforeEach(() => { window.location.hash = ""; forgetPilotToken(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); forgetPilotToken(); });

describe("the Deployment paths panel", () => {
  test("loading, error and empty states each say so in words", () => {
    const loading = render(<DeploymentPaths load={{ status: "loading" }} />);
    expect(within(loading.container).getByRole("status").textContent).toContain("Loading deployment paths");
    loading.unmount();
    const error = render(<DeploymentPaths load={{ status: "error" }} />);
    expect(within(error.container).getByRole("note").textContent).toContain("could not be loaded");
    expect(within(error.container).queryAllByRole("button")).toEqual([]);
    error.unmount();
    const empty = render(<DeploymentPaths load={{ status: "ready", report: { ...report(), paths: [] } }} />);
    expect(within(empty.container).getByRole("note").textContent).toContain("No deployment paths are recorded");
  });

  test("rows follow the readiness order, grouped by cloud in fieldsets, with the status in words and the first blocking reason", () => {
    const { container } = render(<DeploymentPaths load={{ status: "ready", report: report() }} />);
    const groups = [...container.querySelectorAll("fieldset")];
    expect(groups.map((g) => g.querySelector("legend")?.textContent)).toEqual(["Azure", "AWS", "Google Cloud (GCP)"]);
    const rows = [...container.querySelectorAll<HTMLElement>(".paths-row")];
    expect(rows.map((r) => r.dataset.path)).toEqual(["AZURE/TERRAFORM", "AZURE/BICEP", "AWS/TERRAFORM", "AWS/CDK", "GCP/TERRAFORM", "GCP/NATIVE_API"]);
    const badge = (path: string) => container.querySelector(`[data-path="${path}"] .paths-badge`)?.textContent;
    expect(badge("AZURE/TERRAFORM")).toBe("Ready");
    expect(badge("AWS/TERRAFORM")).toBe("Waiting on owner inputs");
    expect(badge("AWS/CDK")).toBe("Blocked: engineering or qualification");
    expect(badge("AZURE/BICEP")).toBe("Blocked: engineering or qualification");
    expect(badge("GCP/TERRAFORM")).toBe("Not in this release");
    expect(container.querySelector('[data-path="AZURE/TERRAFORM"]')?.textContent).toContain("The reviewed path");
    // READY is the last check's answer, shown with its time; an approval rule is configured, no approval is claimed.
    const readyText = container.querySelector('[data-path="AZURE/TERRAFORM"] .paths-reason')?.textContent ?? "";
    expect(readyText).toMatch(/^Authorized and ready in DEV at the last check \(\d{1,2}:\d{2}.*\)\. Each change still needs 1 approval\(s\) before it can run\.$/);
    expect(readyText).not.toMatch(/approved/i);
    expect(container.querySelector('[data-path="AWS/TERRAFORM"] .paths-reason')?.textContent).toBe("Waits on the owner: Owner supervision and inputs.");
    expect(container.querySelector('[data-path="AWS/CDK"] .paths-reason')?.textContent).toBe("Waits on engineering: Qualify the three adapters.");
    // Keyboard order is the visual order: one button per row, in the same order as the rows.
    const buttons = within(container).getAllByRole("button");
    expect(buttons.map((b) => b.closest<HTMLElement>(".paths-row")?.dataset.path)).toEqual(rows.map((r) => r.dataset.path));
    expect(buttons.every((b) => !b.hasAttribute("tabindex"))).toBe(true);
  });

  test("selecting a path only opens what it needs; it starts, selects or sends nothing", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { container } = render(<DeploymentPaths load={{ status: "ready", report: report() }} />);
    const cdk = within(container.querySelector<HTMLElement>('[data-path="AWS/CDK"]')!).getByRole("button");
    expect(cdk.getAttribute("aria-expanded")).toBe("false");
    const details = document.getElementById(cdk.getAttribute("aria-controls")!)!;
    expect(details.hidden).toBe(true);
    fireEvent.click(cdk);
    expect(cdk.getAttribute("aria-expanded")).toBe("true");
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain("Qualify the three adapters. Then run it.");
    expect(details.textContent).toContain("Every step tested with stand-ins only (synthetic, not live)");
    expect(details.querySelector("table")).toBeNull();
    // The contract's path shows the three decisions per environment, READY first.
    const azure = within(container.querySelector<HTMLElement>('[data-path="AZURE/TERRAFORM"]')!).getByRole("button");
    fireEvent.click(azure);
    const table = document.getElementById(azure.getAttribute("aria-controls")!)!.querySelector("table")!;
    expect([...table.querySelectorAll("tbody tr")].map((r) => (r as HTMLElement).dataset.environment)).toEqual(["DEV", "QA", "PROD"]);
    expect(table.querySelector('[data-environment="DEV"]')?.textContent).toMatch(/Yes, at the last check \(\d{1,2}:\d{2}/);
    expect(table.querySelector('[data-environment="DEV"]')?.textContent).toContain("Rule set: each change needs 1 approval(s)");
    expect(table.querySelector('[data-environment="QA"]')?.textContent).toContain("Not checked yet");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(within(container).queryAllByRole("button", { name: /apply|run|start|enable|deploy|choose/i })).toEqual([]);
  });
});

async function unlockWizard(paths: { status: number; body: unknown }, fake?: Fake) {
  const calls = install(paths, fake);
  render(<PilotWizard level="BEGINNER" />);
  fireEvent.change(await screen.findByLabelText(COPY.unlockLabel), { target: { value: TOKEN } });
  fireEvent.click(screen.getByRole("button", { name: COPY.unlockButton }));
  await screen.findByRole("progressbar");
  return calls;
}

describe("the wizard's environment step", () => {
  test("environments are listed readiest first; one the contract does not enable stays visible, disabled, after the enabled ones, with its reason", async () => {
    const environments = [decision("DEV"), decision("QA", { ready: true, checkedAt: CHECKED }), decision("PROD", { authorized: false, approved: false, operations: [] })];
    const calls = await unlockWizard({ status: 200, body: report(environments) });
    // The panel sits above the wizard, read-only, and was read with a GET only.
    const panel = await screen.findByTestId("deployment-paths");
    const wizard = screen.getByRole("region", { name: COPY.heading });
    expect(panel.compareDocumentPosition(wizard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(calls.filter((c) => c.url === "/pilot/paths").every((c) => c.method === "GET")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: COPY.pathContinue }));
    await screen.findByRole("heading", { name: STEP_TITLES[1] });
    const select = screen.getByLabelText(COPY.readyEnvironment) as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map((o) => o.value)).toEqual(["QA", "DEV", "PROD"]));
    expect([...select.options].map((o) => o.disabled)).toEqual([false, false, true]);
    expect(select.options[0].textContent).toMatch(/^QA \(ready at the last check, \d{1,2}:\d{2}.*\)$/);
    expect(select.options[2].textContent).toBe("PROD (not enabled)");
    expect(select.value).toBe("DEV");
    const note = screen.getByRole("note", { name: "Environments you cannot choose" });
    expect(note.textContent).toContain("PROD is not enabled: the owner's reviewed rules do not allow changes in PROD.");
    // No request starts a step by itself.
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  test("when the chosen environment is not enabled, the first enabled one is chosen instead", async () => {
    await unlockWizard({ status: 200, body: report([decision("DEV", { authorized: false, approved: false }), decision("QA"), decision("PROD", { ready: true })]) });
    fireEvent.click(screen.getByRole("button", { name: COPY.pathContinue }));
    const select = await screen.findByLabelText(COPY.readyEnvironment) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("PROD"));
    expect([...select.options].map((o) => o.value + (o.disabled ? "-off" : ""))).toEqual(["PROD", "QA", "DEV-off"]);
  });

  test("a readiness result just run for an environment that turns out not enabled stays on screen; the choice is not moved (review of #334, N4)", async () => {
    const unknown = { ...report([]), contract: { state: "UNKNOWN" as const }, paths: [] };
    const fake: Fake = { run: null, pathsReplies: [{ status: 200, body: unknown }] };
    fake.onPreflight = (environment) => {
      fake.run = { id: "pf-1", step: "preflight", status: "DONE", startedAt: CHECKED, transcript: "", result: { exit: 2, data: {
        environment, ready: false, checks: [{ check: "pilot contract enabled and authorizes APPLY in PROD (required before seal)", ok: false, state: "MISSING", responsible: "OWNER" }],
        decisions: { act: "PILOT_ENABLED", contract: { contractSha256: "c".repeat(64), provider: "AZURE", engine: "TERRAFORM" }, authorized: [{ environment: "DEV", operations: ["APPLY"], authorizationSha256: "a".repeat(64) }], approved: [{ environment: "DEV", requiredApprovals: 1 }] },
      } } };
    };
    // After the check, the console knows the rules: PROD is not enabled.
    const afterwards = report([decision("DEV"), decision("QA", { authorized: false, approved: false }), decision("PROD", { authorized: false, approved: false })]);
    await unlockWizard({ status: 200, body: afterwards }, fake);
    fireEvent.click(screen.getByRole("button", { name: COPY.pathContinue }));
    const select = await screen.findByLabelText(COPY.readyEnvironment) as HTMLSelectElement;
    expect([...select.options].map((o) => o.disabled)).toEqual([false, false, false]);
    fireEvent.change(select, { target: { value: "PROD" } });
    fireEvent.click(screen.getByRole("button", { name: COPY.readyRun }));
    await waitFor(() => expect([...select.options].map((o) => o.value + (o.disabled ? "-off" : ""))).toEqual(["DEV", "QA-off", "PROD-off"]));
    expect(select.value).toBe("PROD");
    expect(screen.getByTestId("pilot-decisions").textContent).toContain("No: the owner's reviewed rules do not allow changes in PROD");
    expect(screen.getByRole("note", { name: "Environments you cannot choose" }).textContent).toContain("PROD is not enabled");
  });

  test("without the paths data, today's order stays, every environment can be chosen, and the panel says it could not load", async () => {
    await unlockWizard({ status: 503, body: { error: "PILOT_PATHS_UNAVAILABLE", message: "no" } });
    expect((await screen.findByTestId("deployment-paths")).textContent).toContain("could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: COPY.pathContinue }));
    const select = await screen.findByLabelText(COPY.readyEnvironment) as HTMLSelectElement;
    expect([...select.options].map((o) => [o.value, o.disabled])).toEqual([["DEV", false], ["QA", false], ["PROD", false]]);
    expect(screen.queryByRole("note", { name: "Environments you cannot choose" })).toBeNull();
  });

  test("a reply in another shape is unavailable, never readiness", async () => {
    await unlockWizard({ status: 200, body: { label: "RELEASE_RECORDS", contract: { state: "ENABLED" }, environments: [{ environment: "DEV", authorized: "yes" }], paths: [] } });
    expect((await screen.findByTestId("deployment-paths")).textContent).toContain("could not be loaded");
  });
});

test("with the emergency stop on, the panel says so and shows nothing as ready", () => {
  const stopped = report([decision("DEV"), decision("QA"), decision("PROD")]);
  stopped.contract = { state: "ENABLED", provider: "AZURE", engine: "TERRAFORM", contractSha256: "c".repeat(64), killSwitch: true };
  const { container } = render(<DeploymentPaths load={{ status: "ready", report: stopped }} />);
  expect(container.querySelector(".paths-stop")?.textContent).toContain("The emergency stop is on");
  expect([...container.querySelectorAll(".paths-badge")].map((b) => b.textContent)).not.toContain("Ready");
});

describe("the planning view (DeploymentContext)", () => {
  test("with the paths data, clouds and environments follow the same readiness order", async () => {
    setPilotToken(TOKEN);
    install({ status: 200, body: report([decision("DEV"), decision("QA", { ready: true }), decision("PROD", { authorized: false, approved: false })]) });
    render(<DeploymentContext />);
    const provider = screen.getByRole("combobox", { name: "Cloud or private platform" }) as HTMLSelectElement;
    const stage = screen.getByRole("combobox", { name: "Environment" }) as HTMLSelectElement;
    await waitFor(() => expect([...provider.options].map((o) => o.value)).toEqual(["azure", "aws", "gcp", "private"]));
    expect([...stage.options].map((o) => o.value)).toEqual(["staging", "development", "production"]);
    expect(document.querySelector('[data-readiness="known"]')?.textContent).toContain("readiest first");
    // Still a planning aid: the default selection is unchanged and nothing can be started here.
    expect(stage.value).toBe("development");
    expect(provider.value).toBe("aws");
  });

  test("without the paths data, today's order stays and a note says readiness is unknown; nothing is fetched without the session", () => {
    const calls = install({ status: 200, body: report() });
    render(<DeploymentContext />);
    expect([...(screen.getByRole("combobox", { name: "Environment" }) as HTMLSelectElement).options].map((o) => o.value)).toEqual(["development", "staging", "production"]);
    expect([...(screen.getByRole("combobox", { name: "Cloud or private platform" }) as HTMLSelectElement).options].map((o) => o.value)).toEqual(["aws", "azure", "gcp", "private"]);
    expect(document.querySelector('[data-readiness="unknown"]')?.textContent).toContain("Readiness unknown");
    expect(calls).toEqual([]);
  });
});
