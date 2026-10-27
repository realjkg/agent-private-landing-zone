// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import PilotWizard, { BlockedNotice, ChangeList, DecisionStatus } from "../src/operator-ui/app/pilot/PilotWizard";
import CleanupStep, { CleanupList, LeftoversTable } from "../src/operator-ui/app/pilot/CleanupStep";
import { forgetPilotToken, type PilotPath, type PilotRun, type PreflightCheck, type PreparedFiles, type ReviewSummary } from "../src/operator-ui/app/pilot/pilot-api";
import {
  BLOCKED, CLI_COMMANDS, CODE_COPY, COPY, RESULT_COPY, STEP_TITLES, classifyResult, describeCheck, describeCounts, describeMismatch, dialogCopy, dispositionWord, ownershipWord, reasonFor, reasonWord, retentionOwnerWord,
  type BlockedState, type ResultKind,
} from "../src/operator-ui/app/pilot/pilot-copy";

// The pilot wizard (src/operator-ui/app/pilot): a guided path in plain words. A scripted stand-in for the console answers the
// page, so these tests pin what the person sees and what the page sends, not what the server decides (test/ui-channel.test.ts).

const TOKEN = "tok-" + "a1b2c3d4e5f6".repeat(5);
const read = (path: string): string => readFileSync(new URL("../" + path, import.meta.url), "utf8");

// Words that must never reach primary text. A code, a hash name or an internal term belongs in a Details disclosure.
const JARGON = [
  /sha-?256/i, /\bnonce\b/i, /artifact/i, /tfplan/i, /state_write/i, /embedstatewrite/i, /ed25519/i, /\bpem\b/i, /\boidc\b/i, /\bjson\b/i,
  /\bstdout\b/i, /\bstderr\b/i, /exit code/i, /\bledger\b/i, /kill switch/i, /\bcontract\b/i, /\bmanifest\b/i, /qualif/i, /\bhash/i, /\bengine\b/i,
  /\bACT\b/, /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/,
];
const jargonIn = (text: string): string[] => JARGON.filter((pattern) => pattern.test(text)).map(String);

type Call = { url: string; method: string; token: string | null; type: string | null; body: any };
type Fake = {
  path: PilotPath | null; run: PilotRun | null; calls: Call[];
  reviewReply: unknown; onPost: Record<string, (body: any) => void>;
};
const bundleReview = (over: Partial<ReviewSummary> = {}): ReviewSummary => ({
  environment: "DEV", target: { account: "acct-1", backend: "store/tfstate/dev.tfstate", workspace: "default" }, shortId: "0123456789ab", sourceCommit: "5ec0de0000000000000000000000000000c0ffee",
  requestedBy: "carol", createdAt: "2026-10-12T00:00:00.000Z", counts: { create: 2, update: 1, replace: 0, delete: 0, forget: 0, other: 0 },
  changes: [
    { address: "azurerm_resource_group.pilot", type: "azurerm_resource_group", action: "CREATE" },
    { address: "azurerm_log_analytics_workspace.pilot", type: "azurerm_log_analytics_workspace", action: "UPDATE" },
    { address: "azurerm_storage_account.logs", type: "azurerm_storage_account", action: "CREATE" },
  ], changesOmitted: 0, preview: { engineVersion: "1.9.5", programId: "7e57ab1e0000", qualified: true, qualifiedAt: "2026-10-11T00:00:00.000Z" },
  unit: { unitId: "alzu-0123456789abcdef0123", tags: { "alz-managed-by": "alz", "alz-unit": "alzu-0123456789abcdef0123", "alz-build": "alz-pilot-dev-0123456789ab" }, untagged: [] }, ...over,
});
const doneRun = (step: PilotRun["step"], result: PilotRun["result"], id = step + "-1"): PilotRun => ({ id, step, status: "DONE", startedAt: "2026-10-12T00:00:00.000Z", transcript: "TRANSCRIPT LINE", result });
const waitingRun = (step: PilotRun["step"], kind: NonNullable<PilotRun["dialog"]>["kind"], phrase: string, id = "d-" + kind): PilotRun => ({
  id: step + "-w", step, status: "WAITING", startedAt: "2026-10-12T00:00:00.000Z", transcript: "", dialog: { id, kind, phrase },
});

function install(over: Partial<Fake> = {}): Fake {
  const fake: Fake = { path: null, run: null, calls: [], reviewReply: { ok: true, summary: bundleReview() }, onPost: {}, ...over };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const state = () => ({ unlocked: true, path: fake.path, busy: fake.run !== null && fake.run.status !== "DONE", run: fake.run });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const token = headers["X-ALZ-Pilot-Token"] ?? null;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    fake.calls.push({ url, method: init.method ?? "GET", token, type: headers["Content-Type"] ?? null, body });
    if (token !== TOKEN) return url === "/pilot/state" ? json({ unlocked: false }) : json({ error: "PILOT_TOKEN_REQUIRED", message: "no" }, 401);
    const route = url.replace("/pilot", "");
    if (route === "/state") return json(state());
    if (route === "/path") { fake.path = body.path; return json(state()); }
    if (route === "/reset") { fake.path = null; fake.run = null; return json(state()); }
    if (route === "/review") return json(fake.reviewReply);
    fake.onPost[route]?.(body);
    return json(state(), route === "/answer" || route === "/cancel" ? 200 : 202);
  }));
  return fake;
}

const posts = (fake: Fake, route: string) => fake.calls.filter((call) => call.method === "POST" && call.url === "/pilot" + route);

async function unlocked(level: "BEGINNER" | "ADVANCED" | "EXPERT" = "BEGINNER", over: Partial<Fake> = {}) {
  const fake = install(over);
  const view = render(<PilotWizard level={level} />);
  fireEvent.change(await screen.findByLabelText(COPY.unlockLabel), { target: { value: TOKEN } });
  fireEvent.click(screen.getByRole("button", { name: COPY.unlockButton }));
  await screen.findByRole("progressbar");
  return { fake, view };
}
const clickButton = async (name: string | RegExp) => { fireEvent.click(await screen.findByRole("button", { name })); };
const typeInto = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
/** The requester's name and key file the seal step needs besides the two files (the requester signs the sealed request). */
const typeRequester = () => { typeInto(COPY.sealRequesterLabel, "carol"); typeInto(COPY.sealKeyLabel, "/k.pem"); };

/** The text a person reads: everything except Details disclosures and the one dialog that explains an internal term in words. */
function primaryText(root: ParentNode = document.body): string {
  const clone = (root as HTMLElement).cloneNode(true) as HTMLElement;
  clone.querySelectorAll("details, [data-jargon-ok], code, pre, script, style").forEach((node) => node.remove());
  return clone.textContent ?? "";
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.location.hash = "";
  forgetPilotToken();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("unlocking with the session token", () => {
  test("the wizard is locked until the token from the terminal is pasted, and says why and what to do", async () => {
    const fake = install();
    render(<PilotWizard level="BEGINNER" />);
    expect(await screen.findByLabelText(COPY.unlockLabel)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("button", { name: COPY.unlockButton }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(BLOCKED.LOCKED.why, { exact: false })).toBeTruthy();
    expect(screen.getByText(BLOCKED.LOCKED.next, { exact: false })).toBeTruthy();
    expect(document.body.textContent).toContain("printed a one-time session token in the terminal");
    expect(fake.calls.every((call) => call.method === "GET" && call.url === "/pilot/state")).toBe(true);
  });

  test("a wrong token is explained and forgotten; the right one opens step 1", async () => {
    install();
    render(<PilotWizard level="BEGINNER" />);
    fireEvent.change(await screen.findByLabelText(COPY.unlockLabel), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: COPY.unlockButton }));
    expect((await screen.findByRole("alert")).textContent).toContain(COPY.unlockWrong);
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.change(screen.getByLabelText(COPY.unlockLabel), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: COPY.unlockButton }));
    expect(await screen.findByRole("progressbar")).toBeTruthy();
    expect((screen.getByRole("heading", { level: 3 }) as HTMLElement).textContent).toBe(STEP_TITLES[0]);
  });

  test("the token is held in memory only: not in the page, storage, the address, and sent only in one header to the console", async () => {
    const { fake } = await unlocked();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
    await clickButton(COPY.pathContinue);
    await screen.findByRole("heading", { name: STEP_TITLES[1] });
    for (const call of fake.calls) {
      expect(call.url.startsWith("/pilot/")).toBe(true);
      expect(call.url).not.toContain(TOKEN);
      expect(JSON.stringify(call.body ?? {})).not.toContain(TOKEN);
      if (call.method === "POST") expect(call.type).toBe("application/json");
    }
    expect(fake.calls.filter((call) => call.token === TOKEN).length).toBeGreaterThan(1);
  });

  test("no inline style reaches the page, so the console's style policy holds", async () => {
    await unlocked();
    expect(document.querySelector("[style]")).toBeNull();
  });
});

describe("step 1: the path is chosen once", () => {
  test("choosing the command line shows the exact commands in order, read-only, and turns the buttons off", async () => {
    const { fake } = await unlocked();
    fireEvent.click(screen.getByLabelText(COPY.pathCli));
    await clickButton(COPY.pathContinue);
    await screen.findByText(COPY.pathLockedCli);
    expect(fake.path).toBe("CLI");
    const items = within(document.querySelector(".pilot-commands") as HTMLElement).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector("code")?.textContent)).toEqual(CLI_COMMANDS.map((item) => item.command));
    expect(CLI_COMMANDS.map((item) => item.command.split(" ")[2])).toEqual(["preflight", "prepare", "seal", "approve", "apply", "status"]);
    expect(screen.getByText(COPY.cliNote)).toBeTruthy();
    expect(screen.queryByRole("button", { name: COPY.pathContinue })).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.readyRun })).toBeNull();
    // Choices are locked, and starting over is the one way back.
    expect(screen.getByLabelText(COPY.pathUi).closest("fieldset")?.hasAttribute("disabled")).toBe(true);
    await clickButton(COPY.startOver);
    await waitFor(() => expect(fake.path).toBeNull());
    expect(posts(fake, "/reset").length).toBe(1);
  });

  test("choosing the console locks to the console and moves to the readiness check", async () => {
    const { fake } = await unlocked();
    await clickButton(COPY.pathContinue);
    await screen.findByRole("heading", { name: STEP_TITLES[1] });
    expect(fake.path).toBe("UI");
    expect(posts(fake, "/path")[0].body).toEqual({ path: "UI" });
  });

  test("an approver sees only the steps that are theirs", async () => {
    await unlocked();
    fireEvent.click(screen.getByLabelText(COPY.roleApprover));
    await clickButton(COPY.pathContinue);
    await screen.findByRole("heading", { name: STEP_TITLES[3] });
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuemax")).toBe("2");
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuetext")).toBe("Step 2 of 2: Review and approve");
    expect(within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem").length).toBe(2);
  });
});

describe("step 2: readiness in plain words", () => {
  const checks: PreflightCheck[] = [
    { check: "contract shape (provider, engine, targets, approvals, approvers)", ok: true, state: "READY" },
    { check: "pilot contract enabled and authorizes APPLY in DEV (required before seal)", ok: false, state: "MISSING", responsible: "OWNER", detail: "enabled: the contract does not enable ACT" },
    { check: "identities configured, distinct, no fallback (DISCOVERY, STATE, STATE_WRITE, APPLY)", ok: false, state: "INVALID", responsible: "OPERATOR", detail: "IDENTITY_COLLAPSED" },
    { check: "identities aimed at the DEV account", ok: true, state: "READY" },
    { check: "plan will embed STATE_WRITE settings: no", ok: true, state: "READY" },
    { check: "tool terraform installed in an approved directory", ok: false, state: "UNAVAILABLE", responsible: "TOOL" },
    { check: "kill switch absent", ok: false, state: "BLOCKED", responsible: "OWNER" },
    { check: "engine qualified in DEV for seal and apply (TERRAFORM)", ok: false, state: "MISSING", responsible: "OWNER", detail: "No qualification record exists" },
    { check: "identity separation attested on the real DEV backend", ok: false, state: "UNVERIFIED", responsible: "OWNER" },
  ];
  const stateWords: Record<PreflightCheck["state"], string> = {
    READY: COPY.stateReady, MISSING: COPY.stateMissing, INVALID: COPY.stateInvalid, UNVERIFIED: COPY.stateUnverified, UNAVAILABLE: COPY.stateUnavailable,
    BLOCKED: COPY.stateBlocked,
  };
  const partyWords = { OWNER: COPY.partyOwner, OPERATOR: COPY.partyOperator, TOOL: COPY.partyTool } as const;

  test("each red item says what is wrong and the exact fix, each green item says it is ready, and Continue waits for green", async () => {
    const fake = install();
    fake.path = "UI";
    fake.onPost["/preflight"] = () => { fake.run = doneRun("preflight", { exit: 2, data: { ready: false, checks } }); };
    render(<PilotWizard level="BEGINNER" />);
    fireEvent.change(await screen.findByLabelText(COPY.unlockLabel), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: COPY.unlockButton }));
    await clickButton(COPY.pathContinue);
    await screen.findByRole("heading", { name: STEP_TITLES[1] });
    await clickButton(COPY.readyRun);
    await screen.findByText(COPY.readySomeRed);
    const items = Array.from(document.querySelectorAll(".pilot-checks li"));
    expect(items.length).toBe(checks.length);
    for (const [index, item] of items.entries()) {
      const words = describeCheck(checks[index], "DEV");
      expect(words.known).toBe(true);
      // The badge says why, in words: missing, needs correcting, not yet proven or not available here, never just "red".
      expect(item.querySelector(".pilot-badge")?.textContent).toBe(stateWords[checks[index].state]);
      expect(item.querySelector(".pilot-badge")?.getAttribute("data-state")).toBe(checks[index].state);
      if (checks[index].ok) {
        expect(item.textContent).not.toContain("What is wrong");
      } else {
        expect(item.textContent).toContain("What is wrong:");
        expect(item.textContent).toContain(words.wrong);
        expect(item.textContent).toContain("How to fix it:");
        expect(item.textContent).toContain(words.fix);
        // Every item that is not ready names who can fix it.
        expect(item.textContent).toContain(COPY.whoFixes + " " + partyWords[checks[index].responsible!]);
      }
    }
    // Whether the sign-ins stay separate on the real cloud is an item with evidence behind it, not a standing note.
    expect(items[8].textContent).toContain(COPY.stateUnverified);
    expect(screen.getByRole("button", { name: COPY.readyContinue }).hasAttribute("disabled")).toBe(true);
    expect(document.querySelector('[data-blocked="NOT_READY"]')?.textContent).toContain(BLOCKED.NOT_READY.next);
    // No code or internal name in the primary text at the beginner level.
    expect(document.body.textContent).not.toContain("IDENTITY_COLLAPSED");
    expect(jargonIn(primaryText())).toEqual([]);
    // Fixed, checked again, green.
    fake.onPost["/preflight"] = () => { fake.run = doneRun("preflight", { exit: 0, data: { ready: true, checks: checks.map((c) => ({ ...c, ok: true, state: "READY" as const })) } }, "preflight-2"); };
    await clickButton(COPY.readyRerun);
    await screen.findByText(COPY.readyAllGreen);
    const next = screen.getByRole("button", { name: COPY.readyContinue });
    expect(next.hasAttribute("disabled")).toBe(false);
    fireEvent.click(next);
    await screen.findByRole("heading", { name: STEP_TITLES[2] });
  });

  test("every line the real readiness check can print has words, so none falls back to a bare name", () => {
    const source = read("src/apply/readiness.ts");
    const names = [...source.matchAll(/\badd\("((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
    const dynamic = [
      "contract shape (provider, engine, targets, approvals, approvers)", "pilot contract enabled and authorizes APPLY in DEV (required before seal)",
      "identities configured, distinct, no fallback (A, B)", "identities aimed at the QA account", "plan will embed STATE_WRITE settings: yes",
      "tool terraform installed in an approved directory", "tool aws installed in an approved directory", "kill switch absent",
      "engine qualified in DEV for seal and apply (TERRAFORM)", "identity separation attested on the real DEV backend", "financial controls (budget alerts or cost cap)",
    ];
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of dynamic) expect(describeCheck({ check: name, ok: false, state: "MISSING" }, "QA").known, name).toBe(true);
    expect(describeCheck({ check: "something new", ok: false, state: "MISSING" }, "DEV").known).toBe(false);
  });
});

describe("the Authorized, Ready and Approved status block", () => {
  const decisions = {
    act: "PILOT_ENABLED" as const, contract: { contractSha256: "c".repeat(64), provider: "AWS", engine: "TERRAFORM" },
    authorized: [{ environment: "DEV" as const, operations: ["APPLY", "CLEANUP"], authorizationSha256: "a".repeat(64) }],
    approved: [{ environment: "DEV" as const, requiredApprovals: 1 }, { environment: "PROD" as const, requiredApprovals: 2 }],
  };
  test("it shows the three decisions separately, from the readiness check's own output", () => {
    const { container } = render(<DecisionStatus readiness={{ environment: "DEV", ready: false, checks: [], decisions }} environment="DEV" />);
    const block = within(container).getByTestId("pilot-decisions");
    expect(block.textContent).toContain("Authorized");
    expect(block.textContent).toContain("APPLY, CLEANUP in DEV");
    expect(block.textContent).toContain("c".repeat(12));
    expect(block.textContent).toContain("a".repeat(12));
    expect(block.textContent).toContain("Not yet");
    expect(block.textContent).toContain("1 approver(s)");
  });
  test("an environment the contract does not authorize, or a disabled contract, reads No", () => {
    const { container } = render(<DecisionStatus readiness={{ environment: "PROD", ready: true, checks: [], decisions }} environment="PROD" />);
    const block = within(container).getByTestId("pilot-decisions");
    expect(block.querySelector("dd")?.getAttribute("data-state")).toBe("no");
    expect(block.textContent).toContain("2 approver(s)");
    const off = render(<DecisionStatus readiness={{ environment: "DEV", ready: false, checks: [], decisions: { ...decisions, act: "DISABLED", contract: { reason: "contract file is missing" }, authorized: [], approved: [] } }} environment="DEV" />);
    expect(within(off.container).getByTestId("pilot-decisions").textContent).toContain("contract file is missing");
  });
});

describe("step 3 and the confirmation dialogs", () => {
  async function atSeal(level: "BEGINNER" | "ADVANCED" | "EXPERT" = "BEGINNER") {
    const ctx = await unlocked(level, { path: "UI" });
    await clickButton(COPY.pathContinue);
    ctx.fake.onPost["/preflight"] = () => { ctx.fake.run = doneRun("preflight", { exit: 0, data: { ready: true, checks: [{ check: "kill switch absent", ok: true, state: "READY" }] } }); };
    await clickButton(COPY.readyRun);
    // Readiness is produced by an asynchronous synthetic response. The user
    // cannot advance until the real UI has enabled Continue.
    await waitFor(() => expect(screen.getByRole("button", { name: COPY.readyContinue }).hasAttribute("disabled")).toBe(false));
    await clickButton(COPY.readyContinue);
    await screen.findByRole("heading", { name: STEP_TITLES[2] });
    return ctx;
  }

  test("sealing needs both boxes and says so; each box has an example", async () => {
    await atSeal();
    expect(screen.getByRole("button", { name: COPY.sealRun }).hasAttribute("disabled")).toBe(true);
    expect(document.querySelector('[data-blocked="FIELDS_MISSING"]')?.textContent).toContain(BLOCKED.FIELDS_MISSING.next);
    expect(screen.getByLabelText(COPY.sealRequestLabel).getAttribute("aria-describedby")).toBeTruthy();
    expect(document.body.textContent).toContain("Example: /home/you/pilot/request-dev.json");
    typeInto(COPY.sealRequestLabel, " /r.json ");
    typeInto(COPY.sealManifestLabel, "/m.json");
    typeRequester();
    expect(screen.getByRole("button", { name: COPY.sealRun }).hasAttribute("disabled")).toBe(false);
  });

  const preparedFiles = (next: PreparedFiles["next"] = { step: "seal", reason: "The TERRAFORM path is qualified." }): PreparedFiles => ({
    files: { request: "/runs/pilot/DEV/request-ab.json", manifest: "/runs/pilot/DEV/manifest-ab.json", record: "/runs/pilot/DEV/preparation-ab.json" },
    summary: {
      label: "LOCAL_PREPARATION", provider: "AWS", engine: "TERRAFORM", path: "PRIMARY", environment: "DEV", account: "111111111111", region: "us-east-1",
      backend: "state-bucket", workspace: "dev", projectRoot: "/home/you/pilot/landing-zone", fileCount: 3,
      providers: [{ source: "registry.terraform.io/hashicorp/aws", version: "6.0.0" }], engineVersion: "1.16.4", engineVersionSource: "TESTED_PIN",
      inputs: [{ name: "region", source: "TFVARS", from: "terraform.tfvars" }, { name: "owner", source: "ENVIRONMENT", from: "ALZ_DISCOVERY_TF_VAR_owner" }],
      policyVersion: "pilot-policy-1", unitHash: "a".repeat(64), manifestHash: "b".repeat(64), contractSha256: "c".repeat(64),
    },
    gaps: ["Inputs and dependencies are not derived yet."], next, request: { environment: "DEV" }, manifest: { schemaVersion: 1 },
  });

  test("getting the files ready from a project folder fills both boxes, shows what was bound in plain words, and keeps the raw files under Advanced", async () => {
    const { fake } = await atSeal();
    expect(screen.getByRole("button", { name: COPY.prepareRun }).hasAttribute("disabled")).toBe(true);
    typeInto(COPY.prepareProjectLabel, " /home/you/pilot/landing-zone ");
    fake.onPost["/prepare"] = () => { fake.run = doneRun("prepare", { exit: 0, code: "PREPARED", data: preparedFiles() }); };
    await clickButton(COPY.prepareRun);
    await screen.findByText(COPY.prepareDone);
    expect(posts(fake, "/prepare")[0].body).toEqual({ environment: "DEV", projectPath: "/home/you/pilot/landing-zone" });
    expect((screen.getByLabelText(COPY.sealRequestLabel) as HTMLInputElement).value).toBe("/runs/pilot/DEV/request-ab.json");
    expect((screen.getByLabelText(COPY.sealManifestLabel) as HTMLInputElement).value).toBe("/runs/pilot/DEV/manifest-ab.json");
    const box = document.querySelector(".pilot-prepared") as HTMLElement;
    for (const text of ["AWS", "Terraform", "111111111111", "us-east-1", "1.16.4", "pilot-policy-1", COPY.prepareLocalOnly, COPY.prepareNextSeal]) expect(box.textContent).toContain(text);
    // The settings it uses, by name and source, never a value.
    expect(box.textContent).toContain(COPY.prepareInputsLabel);
    expect(box.textContent).toContain("region, from " + COPY.prepareFromFile + " terraform.tfvars");
    expect(box.textContent).toContain("owner, from " + COPY.prepareFromEnvironment + " ALZ_DISCOVERY_TF_VAR_owner");
    expect(box.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(box.querySelector("details pre")?.textContent).toContain("schemaVersion");
    expect(jargonIn(primaryText())).toEqual([]);
    typeRequester();
    expect(screen.getByRole("button", { name: COPY.sealRun }).hasAttribute("disabled")).toBe(false);
  });

  test("a preparation that waits on the one-time check or the owner says so instead of offering the preview as ready", async () => {
    const { fake } = await atSeal();
    typeInto(COPY.prepareProjectLabel, "/p");
    fake.onPost["/prepare"] = () => { fake.run = doneRun("prepare", { exit: 0, code: "PREPARED", data: preparedFiles({ step: "qualify", reason: "Qualify it in DEV." }) }); };
    await clickButton(COPY.prepareRun);
    expect(await screen.findByText(COPY.prepareNextCheck)).toBeTruthy();
    expect(screen.queryByText(COPY.prepareNextSeal)).toBeNull();
  });

  test("a missing tool version is asked for only when it is needed, and a refusal says why and what next", async () => {
    const { fake } = await atSeal();
    expect(screen.queryByLabelText(COPY.prepareToolVersionLabel)).toBeNull();
    typeInto(COPY.prepareProjectLabel, "/cdk.out");
    fake.onPost["/prepare"] = () => { fake.run = doneRun("prepare", { exit: 2, code: "ENGINE_VERSION_REQUIRED", message: "x", data: { blocker: "OPERATOR" } }); };
    await clickButton(COPY.prepareRun);
    expect((await screen.findByRole("alert")).textContent).toContain(CODE_COPY.ENGINE_VERSION_REQUIRED.next);
    typeInto(COPY.prepareToolVersionLabel, "2.27.10");
    fake.onPost["/prepare"] = () => { fake.run = doneRun("prepare", { exit: 2, code: "TOOL_UNAVAILABLE", message: "x", data: { blocker: "TOOL", alternative: "Install it with ./alz deps." } }, "prepare-2"); };
    await clickButton(COPY.prepareRun);
    expect(posts(fake, "/prepare")[1].body).toEqual({ environment: "DEV", projectPath: "/cdk.out", awsCliVersion: "2.27.10" });
    expect((await screen.findByRole("alert")).textContent).toContain(CODE_COPY.TOOL_UNAVAILABLE.why);
    expect(screen.getByText("Install it with ./alz deps.")).toBeTruthy();
    expect((screen.getByLabelText(COPY.sealRequestLabel) as HTMLInputElement).value).toBe("");
  });

  test("an open dialog keeps focus: a step change or a re-sent unlock while it is open never moves focus to the step heading, and focus is inside the dialog in the same commit that shows it", async () => {
    const { fake } = await atSeal();
    const phrase = "acct-1 | store/tfstate/dev.tfstate | default";
    fake.onPost["/seal"] = () => { fake.run = waitingRun("seal", "TARGET", phrase); };
    typeInto(COPY.sealRequestLabel, "/r.json");
    typeRequester();
    typeInto(COPY.sealManifestLabel, "/m.json");
    await clickButton(COPY.sealRun);
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText(dialogCopy("TARGET", "DEV").inputLabel) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    // The step changes while the dialog is open. The page behind is inert and hidden from the accessibility tree, and this environment
    // (happy-dom) refuses focus under inert as a browser does; the attribute is lifted here to stand for a browser without inert
    // support and for the commit in which the dialog mounts, where the heading effect runs before the page is made inert. The
    // heading effect runs for the new step and must leave focus in the dialog either way.
    expect(document.querySelector("[inert]")).toBeTruthy();
    document.querySelector("[inert]")!.removeAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: COPY.back, hidden: true }));
    expect(screen.getByRole("heading", { name: STEP_TITLES[1], hidden: true })).toBeTruthy();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(document.activeElement).toBe(input);
    // The console re-sends its state (the poll while a run waits): focus stays in the dialog.
    const polls = fake.calls.filter((call) => call.url === "/pilot/state").length;
    await waitFor(() => expect(fake.calls.filter((call) => call.url === "/pilot/state").length).toBeGreaterThan(polls));
    expect(document.activeElement).toBe(input);
    // After the dialog closes, focus returns to where it was and the next step change moves it to the heading again.
    fake.onPost["/cancel"] = () => { fake.run = doneRun("seal", { exit: 1, code: "HUMAN_CONFIRMATION_MISMATCH", message: "canceled" }); };
    fireEvent.click(within(dialog).getByRole("button", { name: dialogCopy("TARGET", "DEV").cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: COPY.back }));
    expect(screen.getByRole("heading", { name: STEP_TITLES[0] })).toBeTruthy();
    expect(document.activeElement).toBe(document.getElementById("pilot-step-title"));
  });

  test("the target dialog shows the exact phrase and a copy button, starts empty, and cannot be confirmed by anything but the exact phrase", async () => {
    const { fake } = await atSeal();
    const phrase = "acct-1 | store/tfstate/dev.tfstate | default";
    fake.onPost["/seal"] = () => { fake.run = waitingRun("seal", "TARGET", phrase); };
    typeInto(COPY.sealRequestLabel, "/r.json");
    typeRequester();
    typeInto(COPY.sealManifestLabel, "/m.json");
    await clickButton(COPY.sealRun);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    const copy = dialogCopy("TARGET", "DEV");
    expect(within(dialog).getByRole("heading", { name: copy.title })).toBeTruthy();
    expect(within(dialog).getByText(copy.consequence)).toBeTruthy();
    expect(dialog.querySelector("[data-phrase]")?.textContent).toBe(phrase);
    const input = within(dialog).getByLabelText(copy.inputLabel) as HTMLInputElement;
    expect(input.value).toBe("");                    // nothing is filled in for the person
    expect(document.activeElement).toBe(input);      // focus moved into the dialog
    expect(document.querySelector("[inert]")).toBeTruthy(); // the page behind it is inert
    const confirm = within(dialog).getByRole("button", { name: copy.confirm }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    for (const wrong of ["x", phrase.toUpperCase(), phrase + " ", " " + phrase, phrase.slice(0, 10)]) {
      fireEvent.change(input, { target: { value: wrong } });
      expect(confirm.disabled, JSON.stringify(wrong)).toBe(true);
      expect(dialog.textContent).not.toContain("It matches.");
    }
    expect(posts(fake, "/answer")).toEqual([]);
    // The copy button copies the phrase, and only copies.
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(phrase));
    expect((await within(dialog).findAllByText(COPY.copied, { exact: false })).length).toBeGreaterThan(0);
    expect(input.value).not.toBe(phrase);
    expect(posts(fake, "/answer")).toEqual([]);
    fireEvent.change(input, { target: { value: phrase } });
    expect(confirm.disabled).toBe(false);
    expect(dialog.textContent).toContain("It matches.");
    fake.onPost["/answer"] = () => { fake.run = waitingRun("seal", "RUN_PROJECT_CODE", "RUN PROJECT CODE", "d-2"); };
    fireEvent.click(confirm);
    await waitFor(() => expect(posts(fake, "/answer").length).toBe(1));
    expect(posts(fake, "/answer")[0].body).toEqual({ dialogId: "d-TARGET", answer: phrase });
    // The next question replaces the dialog (a new one, empty again).
    const second = await screen.findByRole("heading", { name: dialogCopy("RUN_PROJECT_CODE", "DEV").title });
    expect(second).toBeTruthy();
    expect((screen.getByLabelText(dialogCopy("RUN_PROJECT_CODE", "DEV").inputLabel) as HTMLInputElement).value).toBe("");
  });

  test("Escape and Cancel end the question with nothing sent but a cancel; focus goes back to the button that started it", async () => {
    const { fake } = await atSeal();
    fake.onPost["/seal"] = () => { fake.run = waitingRun("seal", "TARGET", "acct | b | w"); };
    typeInto(COPY.sealRequestLabel, "/r.json");
    typeRequester();
    typeInto(COPY.sealManifestLabel, "/m.json");
    const start = screen.getByRole("button", { name: COPY.sealRun });
    start.focus();
    fireEvent.click(start);
    const dialog = await screen.findByRole("dialog");
    fake.onPost["/cancel"] = () => { fake.run = doneRun("seal", { exit: 1, code: "HUMAN_CONFIRMATION_MISMATCH", message: "x" }); };
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(posts(fake, "/cancel").length).toBe(1));
    expect(posts(fake, "/answer")).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelector("[inert]")).toBeNull();
    // No dead end: the reason and the next step are on screen, and the same button runs it again with the boxes kept.
    expect((await screen.findByRole("alert")).textContent).toContain(CODE_COPY.HUMAN_CONFIRMATION_MISMATCH.next);
    expect((screen.getByLabelText(COPY.sealRequestLabel) as HTMLInputElement).value).toBe("/r.json");
    expect(screen.getByRole("button", { name: COPY.sealRun }).hasAttribute("disabled")).toBe(false);
  });

  test("Tab stays inside the dialog", async () => {
    const { fake } = await atSeal();
    fake.onPost["/seal"] = () => { fake.run = waitingRun("seal", "APPROVE", "APPROVE DEV 0123456789ab"); };
    typeInto(COPY.sealRequestLabel, "/r.json");
    typeRequester();
    typeInto(COPY.sealManifestLabel, "/m.json");
    await clickButton(COPY.sealRun);
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const first = within(dialog).getByRole("button", { name: COPY.copy });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    input.focus();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(document.activeElement).toBe(input); // the browser moves focus between the two; the trap only wraps at the ends
  });

  test("the extra storage sign-in dialog explains itself in words and is the only place that names the internal term", async () => {
    const { fake } = await atSeal();
    fake.onPost["/seal"] = () => { fake.run = waitingRun("seal", "EMBED_STATE_WRITE", "EMBED STATE_WRITE DEV"); };
    typeInto(COPY.sealRequestLabel, "/r.json");
    typeRequester();
    typeInto(COPY.sealManifestLabel, "/m.json");
    await clickButton(COPY.sealRun);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.hasAttribute("data-jargon-ok")).toBe(true);
    expect(dialog.querySelector("[data-phrase]")?.textContent).toBe("EMBED STATE_WRITE DEV");
    const words = dialogCopy("EMBED_STATE_WRITE", "DEV").consequence;
    expect(dialog.textContent).toContain(words);
    expect(words).toMatch(/saved record of your infrastructure/);
    expect(words).toMatch(/becomes able to write/);
    expect(words).toMatch(/not proven/);
    expect(jargonIn(primaryText())).toEqual([]);
  });

  test("every confirmation says what it does in one sentence, asks for one phrase, and only the storage dialog uses the internal term", () => {
    const kinds = ["TARGET", "RUN_PROJECT_CODE", "EMBED_STATE_WRITE", "ATTEST", "APPROVE", "APPLY"] as const;
    for (const kind of kinds) {
      const copy = dialogCopy(kind, "PROD");
      expect(copy.title.length).toBeGreaterThan(5);
      expect(copy.consequence.split(/(?<=[.!?])\s+/).filter(Boolean).length).toBeLessThanOrEqual(kind === "EMBED_STATE_WRITE" ? 4 : 2);
      expect(copy.consequence).toMatch(/[.]$/);
      expect(copy.inputLabel).toMatch(/exactly/);
      if (kind !== "EMBED_STATE_WRITE") {
        expect(jargonIn(copy.title + " " + copy.consequence + " " + copy.inputLabel), kind).toEqual([]);
        expect(copy.jargonOk).toBeUndefined();
      } else {
        expect(copy.jargonOk).toBe(true);
      }
    }
    expect(dialogCopy("APPLY", "PROD").consequence).toContain("PROD");
    expect(dialogCopy("APPLY", "PROD").consequence).toMatch(/no undo/);
    expect(dialogCopy("APPROVE", "QA").consequence).toMatch(/exactly this change/);
  });

  test("what a wrong entry looks like is explained in words, never silently", () => {
    const phrase = "APPLY DEV 0123456789ab acct | b | w";
    expect(describeMismatch(phrase, phrase)).toBe("");
    expect(describeMismatch("", phrase)).toMatch(/Nothing typed/);
    expect(describeMismatch(" " + phrase, phrase)).toMatch(/space at the start/);
    expect(describeMismatch(phrase + " ", phrase)).toMatch(/space at the end/);
    expect(describeMismatch(phrase.toLowerCase(), phrase)).toMatch(/capitals/);
    expect(describeMismatch("APPLY DEV 01", phrase)).toMatch(/So far it matches/);
    expect(describeMismatch("APPLY QA 0123", phrase)).toMatch(/first differs at character 7/);
  });
});

describe("step 4: review and approve", () => {
  async function atReview(role: "OPERATOR" | "APPROVER", level: "BEGINNER" | "ADVANCED" | "EXPERT" = "BEGINNER", review = bundleReview()) {
    const ctx = await unlocked(level, { path: "UI", reviewReply: { ok: true, summary: review } });
    if (role === "APPROVER") fireEvent.click(screen.getByLabelText(COPY.roleApprover));
    await clickButton(role === "APPROVER" ? COPY.pathContinue : COPY.resume);
    await screen.findByRole("heading", { name: STEP_TITLES[3] });
    return ctx;
  }

  test("an approver loads the review, sees what will change in plain words, then signs through a dialog", async () => {
    const { fake } = await atReview("APPROVER");
    expect(document.querySelector('[data-blocked="REVIEW_NOT_LOADED"]')).toBeTruthy();
    typeInto(COPY.approverBundleLabel, "/home/me/review.json");
    await clickButton(COPY.approverLoad);
    await screen.findByText("What will change");
    expect(screen.getByText("2 things will be created")).toBeTruthy();
    expect(screen.getByText("1 thing will be changed in place")).toBeTruthy();
    const rows = Array.from(document.querySelectorAll(".pilot-table tbody tr")).map((row) => row.textContent);
    expect(rows.length).toBe(3);
    expect(rows[0]).toContain("Create");
    expect(rows[1]).toContain("Change");
    expect(document.querySelector(".pilot-warning")).toBeNull();
    expect(screen.getByRole("button", { name: COPY.approverSign }).hasAttribute("disabled")).toBe(true);
    typeInto(COPY.approverKeyLabel, "/home/me/.keys/alice.pem");
    typeInto(COPY.approverNameLabel, "alice");
    fake.onPost["/approve"] = () => { fake.run = waitingRun("approve", "APPROVE", "APPROVE DEV 0123456789ab"); };
    await clickButton(COPY.approverSign);
    expect(posts(fake, "/approve")[0].body).toEqual({ bundlePath: "/home/me/review.json", keyPath: "/home/me/.keys/alice.pem", approverId: "alice" });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(dialogCopy("APPROVE", "DEV").consequence)).toBeTruthy();
    fake.onPost["/answer"] = () => { fake.run = doneRun("approve", { exit: 0, savedPath: "/work/.runs/apply/approvals/0123-alice.json", data: {} }); };
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "APPROVE DEV 0123456789ab" } });
    fireEvent.click(within(dialog).getByRole("button", { name: dialogCopy("APPROVE", "DEV").confirm }));
    await screen.findByText(COPY.approverSigned);
    expect(document.body.textContent).toContain("/work/.runs/apply/approvals/0123-alice.json");
    expect(document.body.textContent).toContain(COPY.approverSendBack);
    // The page never asked for key text, only a location.
    expect(JSON.stringify(posts(fake, "/approve"))).not.toContain("PRIVATE KEY");
  });

  test("a review for the other channel is refused with its reason and next step, never a blank", async () => {
    const { fake } = await atReview("APPROVER");
    fake.reviewReply = { ok: false, code: "CHANNEL_MISMATCH", message: "raw" };
    typeInto(COPY.approverBundleLabel, "/r.json");
    await clickButton(COPY.approverLoad);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(CODE_COPY.CHANNEL_MISMATCH.why);
    expect(alert.textContent).toContain(CODE_COPY.CHANNEL_MISMATCH.next);
    expect(alert.textContent).not.toContain("CHANNEL_MISMATCH");
  });

  test("deletes and replacements are called out before anyone signs", async () => {
    const review = bundleReview({ counts: { create: 0, update: 0, replace: 1, delete: 2, forget: 1, other: 0 }, changes: [
      { address: "a.b", type: "t", action: "DELETE" }, { address: "c.d", type: "t", action: "REPLACE" }, { address: "e.f", type: "t", action: "FORGET" },
      { address: "g.h", type: "t", action: "UPDATE", importing: true, previousAddress: "old.name" },
    ] });
    await atReview("APPROVER", "BEGINNER", review);
    typeInto(COPY.approverBundleLabel, "/r.json");
    await clickButton(COPY.approverLoad);
    await screen.findByText(COPY.reviewDestructive);
    expect(screen.getByText("2 things will be deleted")).toBeTruthy();
    expect(screen.getByText("1 thing will be replaced (removed and made again)")).toBeTruthy();
    expect(screen.getByText("1 thing will stop being tracked but keep running")).toBeTruthy();
    const text = document.querySelector(".pilot-table")!.textContent!;
    expect(text).toContain("Delete");
    expect(text).toContain("Stop tracking");
    expect(text).toContain("the real thing keeps running");
    expect(text).toContain("moved from old.name");
  });

  test("the operator sees the approvals needed, shares the review file, and cannot go on without an approval file", async () => {
    const { fake } = await atReview("OPERATOR");
    expect(document.querySelector('[data-blocked="NOTHING_PREPARED"]')).toBeTruthy();
    typeInto(COPY.approverBundleLabel, "/r.review.json");
    await clickButton(COPY.approverLoad);
    await screen.findByText(COPY.reviewNeeded);
    expect(fake.calls.some((call) => call.url === "/pilot/review")).toBe(true);
    expect(screen.getByRole("button", { name: COPY.reviewContinue }).hasAttribute("disabled")).toBe(true);
    expect(document.querySelector('[data-blocked="NO_APPROVALS_YET"]')?.textContent).toContain(BLOCKED.NO_APPROVALS_YET.next);
    expect(screen.queryByRole("button", { name: COPY.approverSign })).toBeNull();
    typeInto(COPY.reviewApprovalsLabel, "/a/alice.json\n\n/a/bob.json\n");
    expect(screen.getByRole("button", { name: COPY.reviewContinue }).hasAttribute("disabled")).toBe(false);
  });
});

describe("step 5 and 6: apply and the result", () => {
  async function toApply(level: "BEGINNER" | "ADVANCED" | "EXPERT" = "BEGINNER") {
    const ctx = await unlocked(level, { path: "UI", reviewReply: { ok: true, summary: bundleReview() } });
    await clickButton(COPY.pathContinue);
    ctx.fake.onPost["/preflight"] = () => { ctx.fake.run = doneRun("preflight", { exit: 0, data: { ready: true, checks: [{ check: "kill switch absent", ok: true, state: "READY" }] } }); };
    await clickButton(COPY.readyRun);
    // Readiness is produced by an asynchronous synthetic response. The user
    // cannot advance until the real UI has enabled Continue.
    await waitFor(() => expect(screen.getByRole("button", { name: COPY.readyContinue }).hasAttribute("disabled")).toBe(false));
    await clickButton(COPY.readyContinue);
    typeInto(COPY.sealRequestLabel, "/r.json");
    typeRequester();
    typeInto(COPY.sealManifestLabel, "/m.json");
    ctx.fake.onPost["/seal"] = () => {
      ctx.fake.run = doneRun("seal", { exit: 0, data: { sealedPlanPath: "/s/sealed.json", reviewBundlePath: "/s/sealed.json.review.json", artifactSha256: "x".repeat(64) }, summary: bundleReview() });
    };
    await clickButton(COPY.sealRun);
    await clickButton(new RegExp("^" + COPY.next));
    await screen.findByRole("heading", { name: STEP_TITLES[3] });
    // The review file location is carried over from the preparation step, ready to send to the approvers.
    expect(document.body.textContent).toContain("/s/sealed.json.review.json");
    typeInto(COPY.reviewApprovalsLabel, "/a/alice.json");
    await clickButton(COPY.reviewContinue);
    await screen.findByRole("heading", { name: STEP_TITLES[4] });
    return ctx;
  }

  test("the apply step is prefilled from what the earlier steps produced and asks its final question in a dialog", async () => {
    const { fake } = await toApply();
    expect((screen.getByLabelText(COPY.applySealedLabel) as HTMLInputElement).value).toBe("/s/sealed.json");
    expect((screen.getByLabelText(COPY.reviewApprovalsLabel) as HTMLTextAreaElement).value).toBe("/a/alice.json");
    expect(document.body.textContent).toContain("You are about to apply: 2 things will be created; 1 thing will be changed in place in DEV.");
    fake.onPost["/apply"] = () => { fake.run = waitingRun("apply", "APPLY", "APPLY DEV 0123456789ab acct-1 | store | default"); };
    await clickButton(COPY.applyRun);
    expect(posts(fake, "/apply")[0].body).toEqual({
      environment: "DEV", requestPath: "/r.json", manifestPath: "/m.json", sealedPath: "/s/sealed.json", approvalPaths: ["/a/alice.json"],
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Apply this change to DEV" })).toBeTruthy();
    expect(within(dialog).getByText(dialogCopy("APPLY", "DEV").consequence)).toBeTruthy();
  });

  const results: Array<[string, NonNullable<PilotRun["result"]>, ResultKind]> = [
    ["applied", { exit: 0, data: { outcome: "SUCCEEDED", sourceCommit: "5ec0de0000000000000000000000000000c0ffee" } }, "APPLIED"],
    ["blocked before anything", { exit: 2, code: "KILL_SWITCH_ACTIVE", message: "m" }, "NOTHING_CHANGED"],
    ["wrong phrase", { exit: 1, code: "APPLY_CONFIRMATION_MISMATCH", message: "m" }, "NOTHING_CHANGED"],
    ["failed with no change", { exit: 3, code: "APPLY_FAILED", outcome: "FAILED_NO_CHANGE", message: "m" }, "APPROVALS_SPENT"],
    ["approvals spent", { exit: 3, code: "APPROVALS_SPENT", message: "m" }, "APPROVALS_SPENT"],
    ["stop appeared after approvals", { exit: 3, code: "KILL_SWITCH_AFTER_APPROVALS", message: "m" }, "APPROVALS_SPENT"],
    ["partial", { exit: 3, code: "APPLY_FAILED", outcome: "PARTIAL_REQUIRES_REVIEW", message: "m" }, "NEEDS_REVIEW"],
    ["killed", { exit: 3, code: "APPLY_FAILED", outcome: "KILLED", message: "m" }, "NEEDS_REVIEW"],
    ["record not written", { exit: 1, code: "EVIDENCE_REJECTED", message: "m" }, "NEEDS_REVIEW"],
    ["spent for a reason nobody named", { exit: 3, code: "SOMETHING_NEW", message: "m" }, "NEEDS_REVIEW"],
  ];
  test.each(results)("%s ends as the right kind of result", async (_name, result, kind) => {
    expect(classifyResult("apply", result)).toBe(kind);
    const { fake } = await toApply();
    fake.onPost["/apply"] = () => { fake.run = waitingRun("apply", "APPLY", "APPLY DEV 0123456789ab acct-1 | store | default"); };
    await clickButton(COPY.applyRun);
    const dialog = await screen.findByRole("dialog");
    fake.onPost["/answer"] = () => { fake.run = doneRun("apply", result); };
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "APPLY DEV 0123456789ab acct-1 | store | default" } });
    fireEvent.click(within(dialog).getByRole("button", { name: dialogCopy("APPLY", "DEV").confirm }));
    const box = await waitFor(() => {
      const found = document.querySelector("[data-result]");
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(box.getAttribute("data-result")).toBe(kind);
    expect(box.getAttribute("aria-live")).toBe("polite");
    const words = RESULT_COPY[kind];
    expect(box.textContent).toContain(words.headline);
    expect(box.textContent).toContain(words.what);
    for (const line of words.next) expect(box.textContent).toContain(line);
    // An applied record names the app version that ran it; nothing else claims one.
    if (kind === "APPLIED") expect(box.textContent).toContain("App version that ran it: 5ec0de000000");
    else expect(box.textContent).not.toContain("App version that ran it");
    if (kind === "NEEDS_REVIEW") {
      expect(box.textContent).toContain("DO NOT RETRY");
      expect(box.textContent).toMatch(/Call the pilot owner/);
      expect(screen.queryByRole("button", { name: COPY.tryAgain })).toBeNull();
    } else if (kind !== "APPLIED") {
      expect(screen.getByRole("button", { name: COPY.tryAgain })).toBeTruthy();
      expect(box.textContent).toContain("Why it stopped:");
      expect(box.textContent).toContain("What to do next:");
    }
    expect(box.textContent).not.toMatch(/\b(FAILED_NO_CHANGE|PARTIAL_REQUIRES_REVIEW|KILLED|SUCCEEDED|APPLY_FAILED)\b/);
    expect(jargonIn(primaryText(box))).toEqual([]);
  });
});

describe("levels: details appear only where the level shows them", () => {
  async function failedSeal(level: "BEGINNER" | "ADVANCED" | "EXPERT") {
    const ctx = await unlocked(level, { path: "UI" });
    await clickButton(COPY.pathContinue);
    ctx.fake.onPost["/preflight"] = () => { ctx.fake.run = doneRun("preflight", { exit: 0, data: { ready: true, checks: [] } }); };
    await clickButton(COPY.readyRun);
    // Readiness is produced by an asynchronous synthetic response. The user
    // cannot advance until the real UI has enabled Continue.
    await waitFor(() => expect(screen.getByRole("button", { name: COPY.readyContinue }).hasAttribute("disabled")).toBe(false));
    await clickButton(COPY.readyContinue);
    typeInto(COPY.sealRequestLabel, "/r.json");
    typeRequester();
    typeInto(COPY.sealManifestLabel, "/m.json");
    ctx.fake.onPost["/seal"] = () => { ctx.fake.run = doneRun("seal", { exit: 2, code: "ENGINE_NOT_QUALIFIED", message: "Qualification evidence is missing." }); };
    await clickButton(COPY.sealRun);
    return ctx;
  }

  test("beginner sees the reason and the next step and no code; a note for the owner can be copied", async () => {
    await failedSeal("BEGINNER");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(CODE_COPY.ENGINE_NOT_QUALIFIED.why);
    expect(alert.textContent).toContain(CODE_COPY.ENGINE_NOT_QUALIFIED.next);
    expect(document.body.textContent).not.toContain("ENGINE_NOT_QUALIFIED");
    expect(document.querySelector(".pilot details")).toBeNull();
    expect(within(alert).getByRole("button", { name: COPY.supportNote })).toBeTruthy();
  });

  test("advanced and expert get a Details disclosure with the code and the plain line beside it", async () => {
    for (const level of ["ADVANCED", "EXPERT"] as const) {
      await failedSeal(level);
      const alert = await screen.findByRole("alert");
      const details = alert.querySelector("details") as HTMLElement;
      expect(details.textContent).toContain("ENGINE_NOT_QUALIFIED");
      expect(details.querySelector("summary")?.textContent).toBe(COPY.detailsLabel);
      expect(details.hasAttribute("open")).toBe(false);
      expect(primaryText(alert)).not.toContain("ENGINE_NOT_QUALIFIED");
      expect(alert.textContent).toContain(CODE_COPY.ENGINE_NOT_QUALIFIED.next);
      cleanup();
      forgetPilotToken();
    }
  });

  test("expert also sees the command line equivalent of the step", async () => {
    await unlocked("EXPERT", { path: "UI" });
    await clickButton(COPY.pathContinue);
    await screen.findByRole("heading", { name: STEP_TITLES[1] });
    expect(document.querySelector(".pilot-equivalent")?.textContent).toContain("./alz apply preflight");
    cleanup();
    forgetPilotToken();
    await unlocked("ADVANCED");
    expect(document.querySelector(".pilot-equivalent")).toBeNull();
  });
});

describe("every stop has a reason and a next step", () => {
  test("each place the wizard itself is stopped has both, and renders both", () => {
    const states = Object.keys(BLOCKED) as BlockedState[];
    expect(states.length).toBeGreaterThanOrEqual(11);
    for (const state of states) {
      const { why, next } = BLOCKED[state];
      expect(why.trim().length, state).toBeGreaterThan(15);
      expect(next.trim().length, state).toBeGreaterThan(15);
      expect(why, state).not.toBe(next);
      const { unmount } = render(<BlockedNotice state={state} />);
      const note = document.querySelector('[data-blocked="' + state + '"]') as HTMLElement;
      expect(note.textContent).toContain("Why you cannot go on: " + why);
      expect(note.textContent).toContain("What to do next: " + next);
      unmount();
    }
  });

  /** Every code the console can show, read out of the sources that define or emit one (the selector's guard for this file names the same directories). */
  const CODE_SOURCES = ["src/apply/types.ts", "src/cli/apply.ts", "src/cli/ui-channel.ts", "src/apply/prepare.ts", "src/apply/preview-evidence.ts"] as const;
  function codesIn(sources: Record<(typeof CODE_SOURCES)[number], string>): { all: string[]; refusalCodes: string[]; routerCodes: string[]; prepareCodes: string[]; producerCodes: string[] } {
    const refusalCodes = [...sources["src/apply/types.ts"].split("export type ApplyRefusalCode =")[1].split(";")[0].matchAll(/\| "([A-Z_]+)"/g)].map((m) => m[1]);
    const cliCodes = [...sources["src/cli/apply.ts"].matchAll(/\bfail\(\s*"([A-Z_]+)"|\bcode: "([A-Z_]+)"|, "([A-Z_]+_MISMATCH)", ?"[A-Z_]+"\)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    const routerCodes = [...sources["src/cli/ui-channel.ts"].matchAll(/new Bad\(\d+, "([A-Z_]+)"/g)].map((m) => m[1]);
    const prepareCodes = [...sources["src/apply/prepare.ts"].split("export type PrepareCode =")[1].split(";")[0].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    // The preview-evidence producer's refusals reach the terminal and the console through the CLI's `dry.code` and `built.code`
    // (#257 round 2, NB6): the code union of PreviewEvidenceRefusal, plus any PREVIEW_* literal it fails or throws with.
    const producer = sources["src/apply/preview-evidence.ts"];
    const producerCodes = [
      ...[...(/export type PreviewEvidenceRefusal = \{[^}]*\}/.exec(producer)?.[0] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]),
      ...[...producer.matchAll(/\b(?:fail|refuse)\(\s*"([A-Z_]+)"|\bcode: "([A-Z_]+)"|throw new Error\("(PREVIEW_[A-Z_]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]),
    ];
    const extra = ["MANIFEST_INVALID", "APPLY_UNEXPECTED_ERROR", "PILOT_FAILED", "PILOT_UNREACHABLE", "LOCAL_HOST_ONLY", "NOT_FOUND"];
    return { all: [...new Set([...refusalCodes, ...cliCodes, ...routerCodes, ...prepareCodes, ...producerCodes, ...extra])], refusalCodes, routerCodes, prepareCodes, producerCodes };
  }
  const sourcesOnDisk = () => Object.fromEntries(CODE_SOURCES.map((path) => [path, read(path)])) as Record<(typeof CODE_SOURCES)[number], string>;
  const withoutWords = (all: string[]): string[] => all.filter((code) => { const entry = CODE_COPY[code]; return !entry || entry.why.trim().length <= 10 || entry.next.trim().length <= 10; });

  test("every code any step can end with has plain words for why and what next", () => {
    const { all, refusalCodes, routerCodes, prepareCodes, producerCodes } = codesIn(sourcesOnDisk());
    expect(prepareCodes.length).toBeGreaterThanOrEqual(12);
    expect(refusalCodes.length).toBeGreaterThanOrEqual(25);
    expect(routerCodes.length).toBeGreaterThanOrEqual(12);
    expect(producerCodes).toEqual(expect.arrayContaining(["GATE_UNKNOWN", "SCENARIO_MISMATCH", "CONTRACT_MISMATCH"]));
    for (const code of all) {
      const entry = CODE_COPY[code];
      expect(entry, code + " has no plain words").toBeTruthy();
      expect(entry.why.trim().length, code).toBeGreaterThan(10);
      expect(entry.next.trim().length, code).toBeGreaterThan(10);
      expect(reasonFor(code)).toBe(entry);
    }
    expect(reasonFor("A_CODE_NOBODY_HAS_SEEN")).toBe(CODE_COPY.UNKNOWN_CODE);
    expect(CODE_COPY.UNKNOWN_CODE.next).toMatch(/Tell the pilot owner/);
  });

  test("a code added to the preview-evidence producer, the CLI, the router, the prepare codes or the refusal codes without plain words fails the check", () => {
    const sources = sourcesOnDisk();
    expect(withoutWords(codesIn(sources).all)).toEqual([]);
    const probes: [string, (typeof CODE_SOURCES)[number], (text: string) => string][] = [
      ["a new member of PreviewEvidenceRefusal", "src/apply/preview-evidence.ts", (t) => t.replace('code: "GATE_UNKNOWN" |', 'code: "GATE_UNKNOWN" | "PROBE_PRODUCER_UNION" |')],
      ["a PREVIEW_* throw in the producer", "src/apply/preview-evidence.ts", (t) => t + '\nfunction probe() { throw new Error("PREVIEW_PROBE_THROWN: x"); }\n'],
      ["a refusal object in the producer", "src/apply/preview-evidence.ts", (t) => t + '\nconst probe = { ok: false, code: "PROBE_PRODUCER_OBJECT", message: "x" };\n'],
      ["a fail() in the CLI", "src/cli/apply.ts", (t) => t + '\nfunction probe() { fail("PROBE_CLI_CODE", "x"); }\n'],
      ["a router refusal", "src/cli/ui-channel.ts", (t) => t + '\nconst probe = new Bad(400, "PROBE_ROUTER_CODE");\n'],
      ["a prepare code", "src/apply/prepare.ts", (t) => t.replace("export type PrepareCode =", 'export type PrepareCode = "PROBE_PREPARE_CODE" |')],
      ["a refusal code", "src/apply/types.ts", (t) => t.replace("export type ApplyRefusalCode =", 'export type ApplyRefusalCode =\n  | "PROBE_REFUSAL_CODE"')],
    ];
    for (const [label, path, inject] of probes) {
      const mutated = { ...sources, [path]: inject(sources[path]) };
      expect(mutated[path], label).not.toBe(sources[path]);
      const missing = withoutWords(codesIn(mutated).all);
      expect(missing, label).toHaveLength(1);
      expect(missing[0], label).toMatch(/^(?:PROBE_|PREVIEW_PROBE_)/);
    }
  });

  test("every ending of an apply says whether nothing changed, whether anything was used up, and who to call when it is unsafe", () => {
    for (const kind of Object.keys(RESULT_COPY) as ResultKind[]) {
      const words = RESULT_COPY[kind];
      expect(words.headline.length).toBeGreaterThan(3);
      expect(words.what.length).toBeGreaterThan(20);
      expect(words.next.length).toBeGreaterThan(0);
    }
    expect(RESULT_COPY.NEEDS_REVIEW.next.join(" ")).toMatch(/DO NOT RETRY/);
    expect(RESULT_COPY.NEEDS_REVIEW.next.join(" ")).toMatch(/Call the pilot owner/);
    expect(RESULT_COPY.APPROVALS_SPENT.what).toMatch(/approvals were already used/);
    expect(RESULT_COPY.NOTHING_CHANGED.what).toMatch(/nothing was used up/);
  });
});

describe("the words are plain", () => {
  test("no primary string in the copy module uses an internal term (the storage dialog and the commands are the two explained exceptions)", () => {
    const strings: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(COPY)) if (!/^eg[A-Z]/.test(key)) strings.push(["COPY." + key, value]);
    for (const [key, value] of Object.entries(CODE_COPY)) strings.push(["CODE." + key + ".why", value.why], ["CODE." + key + ".next", value.next]);
    for (const [key, value] of Object.entries(BLOCKED)) strings.push(["BLOCKED." + key + ".why", value.why], ["BLOCKED." + key + ".next", value.next]);
    for (const [key, value] of Object.entries(RESULT_COPY)) strings.push(["RESULT." + key, value.headline + " " + value.what + " " + value.next.join(" ")]);
    for (const kind of ["TARGET", "RUN_PROJECT_CODE", "ATTEST", "APPROVE", "APPLY"] as const) {
      const copy = dialogCopy(kind, "QA");
      strings.push(["DIALOG." + kind, [copy.title, copy.consequence, copy.inputLabel, copy.cancel, copy.confirm].join(" ")]);
    }
    for (const title of STEP_TITLES) strings.push(["STEP." + title, title]);
    for (const item of CLI_COMMANDS) strings.push(["CLI." + item.command, item.who + " " + item.what]);
    for (const environment of ["DEV", "QA", "PROD"] as const) {
      for (const name of ["contract shape (x)", "pilot contract enabled and authorizes APPLY in " + environment + " (x)", "identities configured, distinct, no fallback (x)", "identities aimed at the " + environment + " account",
        "plan will embed STATE_WRITE settings: yes", "plan will embed STATE_WRITE settings: no", "tool terraform installed in an approved directory", "kill switch absent",
        "engine qualified in DEV for seal and apply (x)", "identity separation attested on the real DEV backend", "financial controls (budget alerts or cost cap)"]) {
        const words = describeCheck({ check: name, ok: false, state: "MISSING" }, environment);
        strings.push(["CHECK." + name, words.label + " " + words.wrong + " " + words.fix]);
      }
    }
    expect(strings.length).toBeGreaterThan(120);
    const offenders = strings.map(([where, text]) => [where, jargonIn(text)] as const).filter(([, found]) => found.length > 0);
    expect(offenders).toEqual([]);
    // The lint can fail: it catches each term it is built on.
    for (const term of ["sha256", "the nonce", "an artifact", "a tfplan", "STATE_WRITE", "IDENTITY_NOT_CONFIGURED", "the contract", "a JSON file", "the engine"]) {
      expect(jargonIn("Please open " + term + " now"), term).not.toEqual([]);
    }
  });

  test("the words the page shows in each state, read as a person reads them, contain no internal term", async () => {
    // Locked.
    install();
    const first = render(<PilotWizard level="BEGINNER" />);
    await screen.findByLabelText(COPY.unlockLabel);
    expect(jargonIn(primaryText())).toEqual([]);
    first.unmount();
    // Step 1 on both paths, then the later steps for an approver.
    const { fake } = await unlocked();
    expect(jargonIn(primaryText())).toEqual([]);
    fireEvent.click(screen.getByLabelText(COPY.pathCli));
    await clickButton(COPY.pathContinue);
    await screen.findByText(COPY.pathLockedCli);
    expect(jargonIn(primaryText())).toEqual([]);
    await clickButton(COPY.startOver);
    await waitFor(() => expect(fake.path).toBeNull());
    fireEvent.click(screen.getByLabelText(COPY.roleApprover));
    fireEvent.click(screen.getByLabelText(COPY.pathUi));
    await clickButton(COPY.pathContinue);
    await screen.findByRole("heading", { name: STEP_TITLES[3] });
    expect(jargonIn(primaryText())).toEqual([]);
    typeInto(COPY.approverBundleLabel, "/r.json");
    await clickButton(COPY.approverLoad);
    await screen.findByText("What will change");
    expect(jargonIn(primaryText())).toEqual([]);
  });
});

describe("step 7: the cleanup requester signs the proposal", () => {
  test("the proposal is written only with the requester's name and key file, and the page sends both with the prepared change file", async () => {
    const fake = install({ path: "UI" });
    const observation = { verdict: "VERIFIED", inventory: "COMPLETE", observedAt: "2026-10-12T00:00:00.000Z", resources: [], missingFromState: [], unexpected: [] };
    const begin = async (action: () => Promise<unknown>) => { await action(); };
    render(<CleanupStep level="BEGINNER" environment="PROD" serverPath="UI" active={false} run={doneRun("observe", { exit: 0, data: observation })} sealedPath="/runs/sealed.json"
      setSealedPath={() => undefined} requestPath="/r.json" manifestPath="/m.json" begin={begin as never} />);
    const write = await screen.findByRole("button", { name: COPY.proposeRun });
    expect((write as HTMLButtonElement).disabled, "no requester yet").toBe(true);
    typeInto(COPY.proposeRequesterLabel, "carol");
    expect((write as HTMLButtonElement).disabled, "no key file yet").toBe(true);
    typeInto(COPY.proposeKeyLabel, "/home/carol/.keys/carol.pem");
    expect((write as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(write);
    await waitFor(() => expect(posts(fake, "/propose-cleanup")).toHaveLength(1));
    expect(posts(fake, "/propose-cleanup")[0].body).toEqual({ sealedPath: "/runs/sealed.json", requesterId: "carol", keyPath: "/home/carol/.keys/carol.pem" });
    expect(COPY.proposeRequesterHelp).toMatch(/cannot also approve it/);
    expect(jargonIn(COPY.proposeRequesterHelp + " " + COPY.proposeKeyHelp)).toEqual([]);
  });
});

describe("step 7: the cleanup lists say only what the records say", () => {
  /** The ownership classes and retention owners the backend can emit, read from its one definition (src/apply/cleanup-proposal.ts). */
  const union = (name: string): string[] => [...read("src/apply/cleanup-proposal.ts").split("export type " + name + " =")[1].split(";")[0].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  const OWNERSHIPS = union("Ownership");
  const OWNERS = union("RetentionOwner");
  const KEPT = OWNERSHIPS.filter((o) => o !== "RUN_CREATED");
  const PILOT_KEPT = ["PROTECTED_BACKEND", "PROTECTED_IDENTITY", "PROTECTED_DEPLOYMENT", "RETAINED_GROUP", "CONTAINS_OTHERS"];
  const ownerOf = (ownership: string) => (PILOT_KEPT.includes(ownership) ? "PILOT_OWNER" : "ENVIRONMENT_OWNER");
  const summary = (deletes: { address: string; type: string; identifier: string; ownership: string; observed: string }[], excluded: { address: string; type: string; identifier: string; ownership: string; reason: string; retainedBy: string }[]) => ({
    shortId: "0123456789ab", proposalSha256: "0".repeat(64), environment: "DEV" as const, target: { account: "acct", backend: "b", workspace: "default" }, sourceCommit: "c".repeat(40), artifactShortId: "0123456789ab", requestedBy: "carol", requiredApprovals: 1,
    deletes, alreadyAbsent: [], excluded, risks: ["a risk"], lines: ["line"],
  });
  const NEVER = /never (?:removes|removed|deletes|deleted)|were never on the list|whatever this change did/;

  test("every ownership class and retention owner the backend can emit has its own words, so a new class never shows as unknown", () => {
    expect(OWNERSHIPS.length).toBeGreaterThanOrEqual(10);
    expect(OWNERS).toEqual(["PILOT_OWNER", "ENVIRONMENT_OWNER"]);
    for (const ownership of OWNERSHIPS) {
      expect(ownershipWord(ownership), ownership).not.toBe("unknown");
      expect(ownershipWord(ownership).length, ownership).toBeGreaterThan(10);
      expect(jargonIn(ownershipWord(ownership)), ownership).toEqual([]);
    }
    for (const owner of OWNERS) expect(retentionOwnerWord(owner), owner).toMatch(/^kept by the (?:pilot owner|environment's owner)$/);
    expect(ownershipWord("A_CLASS_NOBODY_HAS_SEEN")).toBe("unknown");
    expect(retentionOwnerWord("NOBODY")).toBe("kept by an unknown owner");
    // The identity class covers both clouds and names no cloud's namespace; the scope class names only what the backend emits today.
    expect(ownershipWord("PROTECTED_IDENTITY")).toMatch(/role/);
    expect(ownershipWord("PROTECTED_IDENTITY")).toMatch(/managed identity/);
    expect(ownershipWord("PROTECTED_IDENTITY")).toMatch(/sign-in trust/);
    expect(ownershipWord("PROTECTED_IDENTITY")).not.toMatch(/Microsoft|AWS|IAM/);
    expect(ownershipWord("CONTAINS_OTHERS")).not.toMatch(/nested stack/);
    expect(dispositionWord("UNKNOWN")).toBe("Unresolved: not confirmed gone");
    // Every reason code the records can carry has words, and the fallback is honest.
    for (const code of ["ACCESS_DENIED", "CREDENTIALS", "THROTTLED", "TYPE_NOT_SUPPORTED", "CLI_ERROR", "NOT_INDEPENDENTLY_CHECKABLE", "DATA_BEARING_READ_EXCLUDED", "NO_IDENTIFIER_IN_STATE", "NOT_AN_ARM_RESOURCE_ID", "OUTSIDE_TARGET_SUBSCRIPTION", "UNEXPECTED_RESPONSE", "HOST_REFUSED"]) {
      expect(reasonWord(code), code).not.toMatch(/\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/);
      expect(reasonWord(code).length, code).toBeGreaterThan(10);
    }
    expect(reasonWord("A_REASON_NOBODY_HAS_SEEN")).toBe("the check gave no usable answer");
  });

  test("the note under a proposal is built from that proposal: it says the delete list will be deleted if approved, names only the kept classes present with their owner, and promises nothing about absent classes", () => {
    // Every kept class present: each is named once, with its owner.
    const all = summary([{ address: "thing.one", type: "a_thing", identifier: "id-1", ownership: "RUN_CREATED", observed: "VERIFIED" }],
      KEPT.map((ownership, index) => ({ address: "kept.k" + index, type: "a_kind", identifier: "id-k" + index, ownership, reason: "because " + index, retainedBy: ownerOf(ownership) })));
    const everything = render(<CleanupList cleanup={all} />);
    // Who requested the cleanup is shown with the proposal: their id is part of the proposal every approver signs.
    expect(everything.container.textContent).toContain(COPY.proposeRequestedBy + "carol");
    const note = everything.container.querySelector("[data-retained-note]")!.textContent ?? "";
    expect(note).toContain(COPY.proposeWillDelete);
    for (const ownership of KEPT) {
      expect(note).toContain(ownershipWord(ownership) + " (" + retentionOwnerWord(ownerOf(ownership)) + ")");
      const row = everything.container.querySelector('[data-kept="kept.k' + KEPT.indexOf(ownership) + '"]') as HTMLElement;
      expect(row.textContent).toContain(ownershipWord(ownership));
      expect(row.textContent).toContain(retentionOwnerWord(ownerOf(ownership)));
      expect(row.textContent).not.toMatch(/\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/);
    }
    expect(note).toMatch(/Retiring the environment itself is a separate, reviewed decision/);
    expect(note).not.toMatch(NEVER);
    expect(jargonIn(note)).toEqual([]);
    everything.unmount();
    // An AWS proposal with a run-created role on the delete list and only the backend kept: the note names the backend and nothing about roles.
    const aws = summary([{ address: "aws_iam_role.app", type: "aws_iam_role", identifier: "alz-app-role", ownership: "RUN_CREATED", observed: "VERIFIED" }, { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", identifier: "logs", ownership: "RUN_CREATED", observed: "VERIFIED" }],
      [{ address: "aws_s3_bucket.state", type: "aws_s3_bucket", identifier: "state", ownership: "PROTECTED_BACKEND", reason: "the state backend", retainedBy: "PILOT_OWNER" }]);
    const partial = render(<CleanupList cleanup={aws} />);
    const text = partial.container.textContent ?? "";
    const awsNote = partial.container.querySelector("[data-retained-note]")!.textContent ?? "";
    expect(awsNote).toContain(ownershipWord("PROTECTED_BACKEND") + " (" + retentionOwnerWord("PILOT_OWNER") + ")");
    for (const absent of KEPT.filter((o) => o !== "PROTECTED_BACKEND")) expect(awsNote, absent).not.toContain(ownershipWord(absent));
    expect(text).not.toMatch(/roles? (?:is|are) never|never removes? (?:a |an )?(?:identity|role|resource group|stack)/i);
    expect(text).not.toMatch(NEVER);
    expect(text).toContain("aws_iam_role.app");
    partial.unmount();
    // Nothing kept, nothing to delete: said plainly.
    const empty = render(<CleanupList cleanup={summary([], [])} />);
    const emptyNote = empty.container.querySelector("[data-retained-note]")!.textContent ?? "";
    expect(emptyNote).toMatch(/Nothing is on the delete list, so an approval would delete nothing/);
    expect(emptyNote).toMatch(/Nothing else from this change's records is kept/);
    expect(emptyNote).not.toMatch(NEVER);
    empty.unmount();
  });

  test("a complete leftover check says how many listed things are confirmed gone, whether a cleanup ran, that kept things were left in place and not checked, which kept kinds this record holds, and that the environment is not retired; an unresolved row shows words for its reason", () => {
    const kept = ["PROTECTED_BACKEND", "PROTECTED_IDENTITY", "NOT_IN_PLAN"].map((ownership, index) => ({
      address: "kept." + ownership.toLowerCase(), type: "a_kind", identifier: "id-" + index, disposition: "INTENTIONALLY_RETAINED", basis: "RETENTION_DECISION", reason: ownership + ": the record's own sentence for item " + index, owner: ownerOf(ownership),
    }));
    const gone = [{ address: "thing.one", type: "a_thing", identifier: "id-1", disposition: "CONFIRMED_DELETED", basis: "CLOUD_CONTROL_ABSENT" }, { address: "thing.two", type: "a_thing", identifier: "id-2", disposition: "CONFIRMED_DELETED", basis: "CLOUD_CONTROL_ABSENT" }];
    const base = { disposition: "COMPLETE" as const, sweep: "COMPLETE", nextAction: "Approved resources deleted: every listed resource (2) is confirmed gone.", observedAt: "2026-10-26T00:00:00.000Z" };
    // A cleanup ran and two listed things are gone.
    const ran = render(<LeftoversTable leftovers={{ ...base, resources: [...gone, ...kept], cleanupEvidenceSha256: "a".repeat(64) }} />);
    const headline = ran.container.querySelector("h3")!.textContent ?? "";
    expect(headline).toBe("Approved things deleted: 2 listed thing(s) confirmed gone. " + COPY.verifyKeptNotChecked);
    expect(headline).not.toMatch(/still there|verified|present\b/);
    const retirement = ran.container.querySelector('[data-retirement="OUTSTANDING"]')!.textContent ?? "";
    expect(retirement).toMatch(/^The environment itself is not retired\. Kept and left in place, not checked: /);
    for (const item of kept) {
      const ownership = item.reason.split(":")[0];
      expect(retirement).toContain(ownershipWord(ownership) + " (" + retentionOwnerWord(item.owner) + ")");
      const row = [...ran.container.querySelectorAll("tr")].find((tr) => tr.textContent?.includes(item.address))!;
      expect(row.textContent).toContain(dispositionWord("INTENTIONALLY_RETAINED"));
      expect(row.textContent).toContain(retentionOwnerWord(item.owner));
      expect(row.textContent).toContain(ownershipWord(ownership));
      expect(row.textContent?.replace(item.address, "").replace(item.identifier, "")).not.toMatch(/\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/);
    }
    for (const absent of KEPT.filter((o) => !["PROTECTED_BACKEND", "PROTECTED_IDENTITY", "NOT_IN_PLAN"].includes(o))) expect(retirement, absent).not.toContain(ownershipWord(absent));
    expect(retirement).toMatch(/separate, reviewed action by the pilot owner, and it is still outstanding\.$/);
    expect(retirement).not.toMatch(NEVER);
    expect(retirement).not.toMatch(/resource group or a stack/);
    expect(jargonIn(headline + " " + retirement)).toEqual([]);
    ran.unmount();
    // No cleanup ran, yet the listed things are gone: said so, never "approved things deleted".
    const none = render(<LeftoversTable leftovers={{ ...base, resources: gone, cleanupEvidenceSha256: null }} />);
    expect(none.container.querySelector("h3")!.textContent).toBe("No cleanup ran; the 2 listed thing(s) are confirmed gone anyway. " + COPY.verifyKeptNotChecked);
    expect(none.container.querySelector('[data-retirement="OUTSTANDING"]')!.textContent).toBe("The environment itself is not retired. Nothing from this change's records was kept. " + COPY.verifyRetirementTail);
    none.unmount();
    // Nothing was on the delete list.
    const nothing = render(<LeftoversTable leftovers={{ ...base, resources: kept, cleanupEvidenceSha256: null }} />);
    expect(nothing.container.querySelector("h3")!.textContent).toBe("Nothing was on the delete list, so nothing was deleted. " + COPY.verifyKeptNotChecked);
    nothing.unmount();
    expect(CODE_COPY.CLEANUP_COMPLETE.why).not.toMatch(/Approved things deleted|still there/);
    expect(CODE_COPY.CLEANUP_COMPLETE.next).not.toMatch(/resource group|identity|deployment history/);
    expect(jargonIn(CODE_COPY.CLEANUP_COMPLETE.why + " " + CODE_COPY.CLEANUP_COMPLETE.next)).toEqual([]);
    // Not complete: an unresolved row is "not confirmed gone" with its reason in words, and no retirement line is shown.
    const incomplete = { disposition: "INCOMPLETE" as const, sweep: "COMPLETE", nextAction: "Fix the discovery sign-in's access, then check again.", observedAt: "2026-10-26T00:00:00.000Z", cleanupEvidenceSha256: "a".repeat(64),
      resources: [{ address: "thing.two", type: "a_thing", identifier: "id-2", disposition: "UNKNOWN", basis: "CHECK_FAILED", reason: "ACCESS_DENIED" }] };
    const second = render(<LeftoversTable leftovers={incomplete} />);
    expect(second.container.querySelector("h3")!.textContent).toBe(COPY.verifyIncomplete);
    expect(second.container.querySelector('[data-retirement="OUTSTANDING"]')).toBeNull();
    const unresolved = second.container.querySelector('[data-disposition="UNKNOWN"]') as HTMLElement;
    expect(unresolved.textContent).toContain("Unresolved: not confirmed gone: " + reasonWord("ACCESS_DENIED"));
    expect(unresolved.textContent).not.toMatch(/ACCESS_DENIED|Confirmed gone|Kept on purpose/);
    second.unmount();
  });
});

describe("accessibility and mobile", () => {
  test("every input has a label, the progress bar names the step, and the step heading takes focus when a step opens", async () => {
    await unlocked();
    await clickButton(COPY.pathContinue);
    const heading = await screen.findByRole("heading", { name: STEP_TITLES[1] });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuetext")).toBe("Step 2 of 7: Check readiness");
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    for (const control of Array.from(document.querySelectorAll("input, select, textarea"))) {
      const id = control.getAttribute("id");
      const labelled = (id && document.querySelector('label[for="' + id + '"]')) || control.closest("label") || control.getAttribute("aria-label");
      expect(labelled, control.outerHTML).toBeTruthy();
    }
    expect(document.querySelector('[role="status"][aria-live="polite"]')).toBeTruthy();
  });

  test("a stalled console is said in words with a next step, as an alert", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    render(<PilotWizard level="BEGINNER" />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(COPY.sessionLost);
    expect(alert.textContent).toContain(CODE_COPY.PILOT_UNREACHABLE.next);
  });

  test("the stylesheet has the narrow-screen rules, keeps color as a second cue, and uses no inline style", () => {
    const css = read("src/operator-ui/app/pilot/pilot.css");
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*\.pilot-steps[\s\S]*display: none/);
    expect(css).toMatch(/\.pilot-dialog[\s\S]*max-width: 640px/);
    expect(css).toMatch(/var\(--accent\)/);
    expect(css).not.toMatch(/style=/);
    const source = read("src/operator-ui/app/pilot/PilotWizard.tsx") + read("src/operator-ui/app/pilot/PilotDialog.tsx");
    expect(source).not.toMatch(/\bstyle=\{/);
    expect(read("src/operator-ui/app/main.tsx")).toContain('import "./pilot/pilot.css"');
  });

  test("the progress fill has a rule for every step of both lengths", () => {
    const css = read("src/operator-ui/app/pilot/pilot.css");
    for (const [of, count] of [[2, 2], [7, 7]] as const) {
      for (let fill = 1; fill <= count; fill += 1) expect(css).toContain('.pilot-bar-fill[data-of="' + of + '"][data-fill="' + fill + '"]');
    }
  });
});

describe("the browser bundle keeps out of the apply path", () => {
  test("no wizard file imports the apply path, the command line or the server", () => {
    for (const file of ["pilot-api.ts", "pilot-copy.ts", "PilotWizard.tsx", "PilotDialog.tsx"]) {
      const text = read("src/operator-ui/app/pilot/" + file);
      expect(text, file).not.toMatch(/from ["'](\.\.\/)+(apply|cli|tools|agent)\//);
      expect(text, file).not.toMatch(/from ["'](\.\.\/)+server/);
      expect(text, file).not.toMatch(/node:/);
    }
  });

  test("the preview counts say what they count", () => {
    expect(describeCounts({ create: 0, update: 0, replace: 0, delete: 0, forget: 0, other: 0 })).toEqual(["Nothing will change."]);
    expect(describeCounts({ create: 1, update: 0, replace: 0, delete: 1, forget: 0, other: 2 })).toEqual(["1 thing will be created", "1 thing will be deleted", "2 other changes"]);
  });
});

test("sealed plan review summarizes added, modified and removed resources with policy/access guidance", () => {
  const review=bundleReview({
    counts:{create:2,update:1,replace:1,delete:1,forget:0,other:0},
    changes:[
      {address:"aws_cloudwatch_log_group.new",type:"aws_cloudwatch_log_group",action:"CREATE"},
      {address:"aws_cloudwatch_log_group.old",type:"aws_cloudwatch_log_group",action:"UPDATE"},
      {address:"aws_cloudwatch_log_group.remove",type:"aws_cloudwatch_log_group",action:"DELETE"},
    ],
  });
  render(<ChangeList review={review}/>);
  expect(document.body.textContent).toContain("App version that prepared it5ec0de000000");
  expect(screen.getByText(/Added:/).textContent).toContain("2");
  expect(screen.getByText(/Modified:/).textContent).toContain("1");
  expect(screen.getByText(/Removed or replaced:/).textContent).toContain("2");
  expect(screen.getByText(/Governance: every change remains subject to policy/)).toBeTruthy();
  expect(screen.getByText(/Access: a console session alone/)).toBeTruthy();
  expect(screen.getByText(/Stop unless a separately authorized plan/)).toBeTruthy();
  expect(screen.getByText("aws_cloudwatch_log_group.remove")).toBeTruthy();
});

test("the review says which build tool program made the preview and whether it passed the real-cloud test, in plain words", () => {
  const tested = render(<ChangeList review={bundleReview()} />);
  const yes = document.querySelector('[data-preview-tested="yes"]');
  expect(document.body.textContent).toContain(COPY.reviewToolLabel + COPY.reviewToolVersion + " 1.9.5, " + COPY.reviewToolProgram + " 7e57ab1e0000");
  expect(yes?.textContent).toContain(COPY.reviewTestedYes + " 2026-10-11T00:00:00.000Z");
  expect(jargonIn(primaryText())).toEqual([]);
  tested.unmount();
  const reason = "ENGINE_NOT_QUALIFIED: the qualification record is not backed by real-engine qualification evidence: it was not produced with this engine binary";
  render(<ChangeList review={bundleReview({ preview: { engineVersion: "1.9.5", programId: "0badc0de0000", qualified: false, reason } })} />);
  const no = document.querySelector('[data-preview-tested="no"]');
  expect(no?.textContent).toContain(COPY.reviewTestedNo);
  // The exact reason is there for whoever needs it, folded away from the primary words.
  expect(no?.querySelector("details")?.hasAttribute("open")).toBe(false);
  expect(no?.querySelector("details pre")?.textContent).toBe(reason);
  expect(jargonIn(primaryText())).toEqual([]);
});
