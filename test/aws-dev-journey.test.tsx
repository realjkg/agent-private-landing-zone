// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { OperatorApp } from "../src/operator-ui/app/App";
import AwsDevJourney, { AWS_DEV_SCENARIO } from "../src/operator-ui/app/components/AwsDevJourney";
import type { JobState, ModelAvailability } from "../src/operator-ui/app/api";
import { PHASE_E_SCENARIOS } from "../src/qualification/phase-e.js";

const idle: JobState = { status: "IDLE", title: "No workflow", evidenceBasis: "NOT_RUN", output: "" };
const ready: ModelAvailability = {
  status: "AVAILABLE", reason: "READY", required: ["qwen3:1.7b", "qwen3:4b", "mistral-nemo:12b"], missing: [],
};
const unavailable: ModelAvailability = {
  ...ready, status: "UNAVAILABLE", reason: "MODEL_DIGEST_UNPINNED", missing: ready.required,
};

function stub(models: ModelAvailability | null = ready, rejectRun = false, state: JobState | null = idle) {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/models") return new Response(JSON.stringify(models));
    if (url === "/state") return state ? new Response(JSON.stringify(state)) : new Response("", { status: 403 });
    if (url === "/run") return new Response(JSON.stringify(rejectRun ? { error: "Local setup needs a rebuild." } : {}),
      { status: rejectRun ? 409 : 202 });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function app() {
  return render(<OperatorApp csrfToken="session-token" scenarioIds={[AWS_DEV_SCENARIO]} initialLevel="BEGINNER" />);
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "#aws-dev";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = "";
});

test("AWS setup bookmarks and home navigation work without starting a job or contacting AWS", async () => {
  const fetcher = stub();
  window.location.hash = "";
  app();
  expect(screen.getByRole("link", { name: "Start with AWS DEV" }).getAttribute("href")).toBe("#aws-dev");
  await act(async () => {
    window.location.hash = "#aws-dev";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await screen.findByRole("heading", { name: "Start with AWS DEV" });
  await waitFor(() => expect(document.activeElement?.id).toBe("aws-dev-title"));
  const nav = screen.getByRole("navigation", { name: "Console areas" });
  expect(within(nav).getByRole("link", { name: "AWS DEV" }).getAttribute("aria-current")).toBe("page");
  expect(fetcher.mock.calls.every(([url]) => ["/state", "/models"].includes(url))).toBe(true);
  expect(screen.getByRole("link", { name: "Continue to AWS account setup" }).getAttribute("href")).toBe("#pilot");
  expect(screen.queryByLabelText(/session token/i)).toBeNull();
});

test.each([true, false])("one explicit rehearsal uses the existing governed request (live=%s)", async (live) => {
  const fetcher = stub();
  app();
  const button = await screen.findByRole("button", { name: live ? "Rehearse with private models" : "Rehearse offline" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/run")).toHaveLength(1));
  const call = fetcher.mock.calls.find(([url]) => url === "/run")!;
  expect(Object.fromEntries(new URLSearchParams(call[1]?.body as string))).toEqual({
    mode: live ? "matrix-live" : "matrix-offline", scenario: AWS_DEV_SCENARIO, token: "session-token",
  });
  expect(screen.getByText(/A passed rehearsal does not verify AWS access/)).toBeTruthy();
});

test("the fixed scenario exists and exercises AWS Terraform, not another provider", () => {
  expect(PHASE_E_SCENARIOS.find(s => s.id === AWS_DEV_SCENARIO)).toMatchObject({
    provider: "AWS", engine: "TERRAFORM", mock: "brownfield",
  });
});

test("missing model pins explain the fix and retain an explicit offline choice; recheck enables live", async () => {
  const fetcher = stub(unavailable);
  app();
  await screen.findByText(/no release digest is committed/);
  expect((screen.getByRole("button", { name: "Rehearse with private models" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Rehearse offline" }) as HTMLButtonElement).disabled).toBe(false);
  fetcher.mockImplementation(async (url) => new Response(JSON.stringify(url === "/models" ? ready : idle)));
  fireEvent.click(screen.getByRole("button", { name: "Check private models again" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Rehearse with private models" }) as HTMLButtonElement).disabled).toBe(false));
  expect(fetcher.mock.calls.some(([url]) => url === "/run")).toBe(false);
});

test("unknown readiness never presents live inference as ready", async () => {
  stub(null);
  app();
  await screen.findByText(/Private-model readiness is unknown/);
  expect((screen.getByRole("button", { name: "Rehearse with private models" }) as HTMLButtonElement).disabled).toBe(true);
});

test("request rejection is visible at Beginner and does not advance to deployment", async () => {
  stub(ready, true);
  app();
  fireEvent.click(await screen.findByRole("button", { name: "Rehearse offline" }));
  await screen.findByText("Local setup needs a rebuild.");
  expect(window.location.hash).toBe("#aws-dev");
});

test("session loss disables both rehearsal actions", async () => {
  stub(ready, false, null);
  app();
  await screen.findByText(/Restart the workspace before continuing/);
  for (const name of ["Rehearse offline", "Rehearse with private models"]) {
    expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  }
});

test("an in-flight workspace run is restored on reload without issuing another run", async () => {
  const fetcher = stub(ready, false, { ...idle, status: "RUNNING", title: "Existing workspace run" });
  app();
  await screen.findByText("Existing workspace run");
  await waitFor(() => expect((screen.getByRole("button", { name: "Rehearse offline" }) as HTMLButtonElement).disabled).toBe(true));
  expect(fetcher.mock.calls.some(([url]) => url === "/run")).toBe(false);
});

test("missing bundled scenario refuses both modes; Beginner never receives raw output", () => {
  render(<AwsDevJourney modelAvailability={ready} scenarioAvailable={false} busy={false}
    sessionUnavailable={false} jobState={{ ...idle, status: "BLOCKED", output: "policy.input " + "a".repeat(64) }}
    error={null} showTechnicalDetails={false} onRecheckModels={vi.fn()} onLaunch={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toMatch(/missing the AWS Terraform scenario/);
  expect((screen.getByRole("button", { name: "Rehearse offline" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByLabelText("AWS setup run output")).toBeNull();
  expect(document.body.textContent).not.toContain("policy.input");
});
