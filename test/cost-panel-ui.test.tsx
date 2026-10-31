// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { ActDev1Setup } from "../src/operator-ui/app/pilot/ActDev1Setup";
import { badgeClass } from "../src/operator-ui/app/pilot/PilotWizard";
import { describeCheck } from "../src/operator-ui/app/pilot/pilot-copy";
import { CostPanel } from "../src/operator-ui/app/pilot/CostPanel";
import { forgetPilotToken, setPilotToken, type CostVisibility } from "../src/operator-ui/app/pilot/pilot-api";
import { costConfigSummary } from "../src/cost/local";
import { resolveCostConfig } from "../src/design/cost";
import { costStatusOf, type CostVariant } from "./helpers/cost-fixtures";

// The "Cost and visibility" panel (plan item 5). A stand-in answers GET /pilot/cost with statuses read from SYNTHETIC fixtures
// (test/helpers/cost-fixtures.ts); the server side is test/pilot-cost-route.test.ts. Nothing here reads AWS.

afterEach(() => { cleanup(); vi.unstubAllGlobals(); forgetPilotToken(); });

const CONFIG = {
  owner: "platform-team", notifications: { emails: ["finops@example.com"] }, tags: { "cost-center": "cc-1234", environment: "dev" },
  budget: { name: "alz-dev-monthly", amount: "50" }, review: { reviewBy: "2027-01-31" }, limits: { allowedRegions: ["us-east-2"], quantities: { aws_instance: 2 } },
};
const ACTION = {
  enabled: true, type: "APPLY_IAM_POLICY", thresholdPercent: 100, executionRoleArn: "arn:aws:iam::123456789012:role/alz-budget-action",
  policyArn: "arn:aws:iam::123456789012:policy/alz-deny-new-compute", roles: ["workload-deployer"],
};

async function visibility(variant: CostVariant | "none" | "unreadable", config: object = CONFIG): Promise<CostVisibility> {
  return {
    label: "COST_VISIBILITY", readOnly: true, advisory: true, actEnabled: false, command: "./alz cost status --account <account>",
    status: variant === "none" ? { state: "NONE" } : variant === "unreadable" ? { state: "UNREADABLE" } : { state: "OK", cost: await costStatusOf(variant) as never },
    config: { state: "OK", summary: costConfigSummary(resolveCostConfig(config)) },
    contractLimits: { state: "OK", environments: [{ environment: "DEV", limits: { resources: [{ type: "aws_instance", max: 1, sizes: ["t3.micro"] }], regions: ["us-east-2"] }, canary: false }] },
  };
}

function serve(body: unknown, status = 200): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }); }));
  return calls;
}

async function shown(variant: Parameters<typeof visibility>[0], config?: object): Promise<HTMLElement> {
  setPilotToken("session-token-only");
  serve(await visibility(variant, config));
  render(<CostPanel />);
  const panel = screen.getByRole("region", { name: "Cost and visibility" });
  await waitFor(() => expect(within(panel).queryByText(/Loading the saved cost status/)).toBeNull());
  return panel;
}

test("observed: every value carries its label as text, the forecast is an estimate, and the budget is never called a cap", async () => {
  const panel = await shown("observed");
  const text = panel.textContent!;
  expect(text).toContain("Overall: OBSERVED COMPLETE.");
  expect(text).toMatch(/12\.34 USD \[OBSERVED\]/);
  expect(text).toMatch(/40\.1 USD \[ESTIMATE\]/);
  expect(text).toContain("It is not a hard cap");
  expect(text).toContain("None configured: alerts only.");
  expect(text).toContain("finops@example.com");
  // Budgets does not report email confirmation: shown as UNKNOWN with its reason, never as confirmed.
  expect(text).toMatch(/confirmation Unknown \(AWS does not report this\) \[UNKNOWN\]/);
  expect(text).toContain("50.00 USD per monthly period");
  expect(text).toContain("aws_instance: at most 2");
  expect(text).toMatch(/DEV: aws_instance at most 1 \(t3\.micro\); regions us-east-2/);
  expect(text).toContain("platform-team");
  for (const group of ["Budget", "Alerts and recipients", "Required tags and cost allocation", "Cost export (CUR 2.0)", "Provisioning limits", "Ownership", "Freshness"]) {
    expect(within(panel).getByRole("region", { name: group })).toBeTruthy();
  }
  // Read-only: the only button reloads the saved read.
  expect(within(panel).getAllByRole("button").map((b) => b.textContent)).toEqual(["Show the latest saved read"]);
});

test("waiting: deployed with no data yet says so in words, never zero", async () => {
  const text = (await shown("waiting")).textContent!;
  expect(text).toContain("Overall: WAITING.");
  expect(text).toContain("No data yet is not zero spend");
  expect(text).toMatch(/Last delivery\s*No delivery yet \(not found, so it cannot exist yet\)|Last delivery\s*No delivery yet/);
  expect(text).toContain("Waiting for the first delivery (no data yet, not zero)");
});

test("stale: the export stopped delivering", async () => {
  const text = (await shown("stale")).textContent!;
  expect(text).toContain("Overall: STALE.");
  expect(text).toContain("Stale: no recent delivery");
});

test("unknown: a denied read is UNKNOWN with its reason, never a pass", async () => {
  const text = (await shown("incomplete")).textContent!;
  expect(text).toContain("Overall: INCOMPLETE.");
  expect(text).toContain("Unknown: not read");
  expect(text).not.toContain("OBSERVED COMPLETE");
});

test("attention: an alert without a recipient and a missing budget are named", async () => {
  expect((await shown("attention")).textContent).toContain("No recipient: this alert reaches nobody.");
  cleanup();
  const missing = (await shown("missing")).textContent!;
  expect(missing).toContain("Overall: ATTENTION.");
  expect(missing).toContain("Not found in the account");
  expect(missing).toMatch(/No data yet, not zero \(not found, so it cannot exist yet\) \[UNKNOWN\]/);
});

test("no data: nothing read yet reads as no data, never as zero, and names the terminal command", async () => {
  const panel = await shown("none");
  const text = panel.textContent!;
  expect(text).toContain("Overall: NO DATA YET.");
  expect(text).toContain("This is not zero spend.");
  expect(text).toContain("./alz cost status --account <account>");
  expect(text).not.toMatch(/\b0(\.00)? USD\b/);
  cleanup();
  expect((await shown("unreadable")).textContent).toContain("Overall: UNKNOWN.");
});

test("a configured budget action is shown with its effect, and only then", async () => {
  const text = (await shown("observed", { ...CONFIG, budgetAction: ACTION })).textContent!;
  expect(text).toMatch(/Configured \(a person approves each run in AWS Budgets\): When actual spend reaches 100%/);
  expect(text).toContain("it does not stop running resources or cap spend");
});

test("loading, error and request: GET /pilot/cost with the session token; a failure is a note, never data", async () => {
  setPilotToken("session-token-only");
  const calls = serve({ error: "PILOT_FAILED", message: "x" }, 500);
  render(<CostPanel />);
  expect(screen.getByRole("region", { name: "Cost and visibility" }).getAttribute("aria-busy")).toBe("true");
  expect(screen.getByText(/Loading the saved cost status/)).toBeTruthy();
  // Announced politely in the panel's one live region (review N6); advisory, so never an alert that interrupts the wizard.
  await waitFor(() => expect(screen.getByText(/The cost status could not be loaded/).closest("[aria-live]")?.getAttribute("aria-live")).toBe("polite"));
  expect(screen.getByText(/The cost status could not be loaded/).closest("[aria-live]")?.getAttribute("role")).toBe("status");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(calls[0]!.url).toBe("/pilot/cost");
  expect(calls[0]!.init.method).toBe("GET");
  expect((calls[0]!.init.headers as Record<string, string>)["X-ALZ-Pilot-Token"]).toBe("session-token-only");
  // A reply that is not the panel's shape is not shown as data either.
  cleanup();
  serve({ label: "COST_VISIBILITY", readOnly: true, actEnabled: true });
  render(<CostPanel />);
  await waitFor(() => expect(screen.getByText(/The cost status could not be loaded/)).toBeTruthy());
  // The person can ask again, by keyboard.
  serve(await visibility("observed"));
  const again = screen.getByRole("button", { name: "Show the latest saved read" });
  again.focus();
  fireEvent.click(again);
  await waitFor(() => expect(screen.getByText(/Overall: OBSERVED COMPLETE/)).toBeTruthy());
});

test("the setup checklist points to the panel instead of a text-only spending step", async () => {
  serve(await visibility("observed"));
  render(<><ActDev1Setup /><CostPanel /></>);
  fireEvent.click(screen.getByText(/Set up AWS DEV/));
  expect(screen.queryByText(/Confirm spending/)).toBeNull();
  expect(screen.getByText(/Check cost and visibility:/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Go to Cost and visibility" }));
  expect(document.activeElement?.id).toBe("cost-visibility-title");
});

test("N6: a failed reload after a good load is announced in the same polite live region", async () => {
  setPilotToken("session-token-only");
  serve(await visibility("observed"));
  render(<CostPanel />);
  await waitFor(() => expect(screen.getByText(/Overall: OBSERVED COMPLETE/)).toBeTruthy());
  const region = screen.getByText(/Overall: OBSERVED COMPLETE/).closest("section")!.querySelector('[aria-live="polite"]')!;
  expect(region.textContent).toBe("");
  serve({ error: "PILOT_FAILED", message: "x" }, 500);
  fireEvent.click(screen.getByRole("button", { name: "Show the latest saved read" }));
  await waitFor(() => expect(region.textContent).toContain("could not be loaded"));
});

test("N1/N2: the advisory financial badge and words follow its state, and it stays informational (never a stop)", () => {
  const name = "financial controls (budget, alerts and cost visibility; advisory)";
  const expected = { READY: "pilot-badge-ok", UNVERIFIED: "pilot-badge-neutral", MISSING: "pilot-badge-warn", INVALID: "pilot-badge-warn", UNAVAILABLE: "pilot-badge-warn" } as const;
  const words = { READY: /look right.*never caps spend/, UNVERIFIED: /not confirmed yet/, MISSING: /Budget not found/, INVALID: /need attention/, UNAVAILABLE: /unavailable or stale/ } as const;
  for (const state of Object.keys(expected) as (keyof typeof expected)[]) {
    const item = { check: name, ok: true, state, advisory: true as const };
    expect(badgeClass(item).split(" ")).toContain(expected[state]);
    const copy = describeCheck(item, "DEV");
    expect(copy.label, state).toMatch(words[state]);
    expect(copy.informational).toBe(true);
    expect(copy.label).not.toMatch(/is a hard cap|caps spend\./i);
  }
  // A non-advisory item keeps the ok/bad pair.
  expect(badgeClass({ check: "kill switch absent", ok: false, state: "BLOCKED" })).toBe("pilot-badge pilot-badge-bad");
  expect(badgeClass({ check: "kill switch absent", ok: true, state: "READY" })).toBe("pilot-badge pilot-badge-ok");
});
