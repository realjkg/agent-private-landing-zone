// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { OperationDescriptor } from "../src/operator-ui/app/api";
import { OperationsEntry } from "../src/operator-ui/app/operations/OperationsEntry";
import { OperationCard } from "../src/operator-ui/app/operations/OperationCard";
import { describeRefusal } from "../src/operator-ui/app/operations/OperationFields";

const runnable: OperationDescriptor = {
  id: "probe-read", title: "Probe the thing", summary: "Reads one fixture.", family: "evidence",
  cli: "./alz probe [aws|azure]", safety: "READ_ONLY", runnable: true,
  evidenceBasis: "DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD",
  inputs: [
    { kind: "enum", name: "provider", label: "Provider", options: ["aws", "azure"] },
    { kind: "text", name: "target", label: "Target name", pattern: "[a-z][a-z0-9-]*", maxLength: 12, example: "core-net" },
    { kind: "flag", name: "verbose", label: "Verbose output" },
    { kind: "json", name: "report", label: "Report JSON", maxBytes: 100, optional: true },
  ],
};
const handoff: OperationDescriptor = {
  id: "preview-hand", title: "Preview a teardown", summary: "Plans a teardown preview.", family: "teardown",
  cli: "./alz teardown destroy-preview-run", safety: "HANDOFF", runnable: false,
  evidenceBasis: "OPERATOR TERMINAL — NOT RUN BY THE CONSOLE",
  inputs: [
    { kind: "text", name: "target", label: "Target id", pattern: "[a-z][a-z0-9-]*", maxLength: 20, example: "core-net" },
    { kind: "flag", name: "json", label: "JSON output" },
  ],
  handoff: { reason: "A person must type the exact target in a terminal.",
    command: "./alz teardown destroy-preview-run {target} {json}", env: ["AWS_PROFILE"], viewer: "probe-read" },
};

const run = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 202 }));

beforeEach(() => {
  run.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/operations") return new Response(JSON.stringify([runnable, handoff]), { status: 200 });
    return run(url, init);
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const card = (spec: OperationDescriptor, level: "BEGINNER" | "ADVANCED" | "EXPERT" = "ADVANCED", extra = {}) =>
  render(<OperationCard spec={spec} level={level} csrfToken="tok" jobState={null} busy={false}
    onRefresh={() => {}} onOpenViewer={() => {}} {...extra} />);

describe("generic operation card", () => {
  test("renders a control per schema field with labels", () => {
    card(runnable);
    expect(screen.getByLabelText("Provider").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Target name").getAttribute("maxlength")).toBe("12");
    expect(screen.getByLabelText("Verbose output").getAttribute("type")).toBe("checkbox");
    expect(screen.getByLabelText("Report JSON").tagName).toBe("TEXTAREA");
  });

  test("an invalid form shows a role=alert refusal and sends nothing", async () => {
    card(runnable);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Target name is required.");
    fireEvent.change(screen.getByLabelText("Target name"), { target: { value: "ok" } });
    fireEvent.change(screen.getByLabelText("Report JSON"), { target: { value: "{nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Report JSON is not valid JSON."));
    expect(run).not.toHaveBeenCalled();
  });

  test("a valid form posts exactly the operation, its inputs and the token", async () => {
    card(runnable);
    fireEvent.change(screen.getByLabelText("Target name"), { target: { value: "core-net" } });
    fireEvent.click(screen.getByLabelText("Verbose output"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const [url, init] = run.mock.calls[0];
    const body = init!.body as URLSearchParams;
    expect(url).toBe("/run");
    expect([...body.keys()].sort()).toEqual(["inputs", "operation", "token"]);
    expect(body.get("operation")).toBe("probe-read");
    expect(body.get("token")).toBe("tok");
    expect(JSON.parse(body.get("inputs")!)).toEqual({ provider: "aws", target: "core-net", verbose: true });
  });

  test("a server refusal is described in words, and a busy console disables Run", async () => {
    run.mockResolvedValueOnce(new Response('{"error":"INPUT_PATTERN:target"}', { status: 400 }));
    const { unmount } = card(runnable);
    fireEvent.change(screen.getByLabelText("Target name"), { target: { value: "ok" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Target name is not in the expected format."));
    unmount();
    card(runnable, "ADVANCED", { busy: true });
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("disclosure follows the experience level", () => {
    const { unmount } = card(runnable, "BEGINNER");
    expect(screen.queryByText("./alz probe [aws|azure]")).toBeNull();
    expect(screen.getByText(/Protected — this run used recorded examples/)).toBeTruthy();
    unmount();
    const advanced = card(runnable, "ADVANCED");
    expect(screen.getByText("./alz probe [aws|azure]")).toBeTruthy();
    expect(screen.getByText(runnable.evidenceBasis)).toBeTruthy();
    expect(screen.queryByText(/probe-read · READ_ONLY/)).toBeNull();
    advanced.unmount();
    card(runnable, "EXPERT");
    expect(screen.getByText(/probe-read · READ_ONLY · inputs: provider, target, verbose, report/)).toBeTruthy();
  });

  test("a result for this operation shows its status; another operation's result is not shown", () => {
    const state = { status: "PASS" as const, operation: "probe-read", title: "Probe", evidenceBasis: runnable.evidenceBasis, output: "x" };
    const { unmount } = card(runnable, "ADVANCED", { jobState: state });
    expect(screen.getByTestId("op-result").textContent).toMatch(/Last run: PASS/);
    unmount();
    card(runnable, "ADVANCED", { jobState: { ...state, operation: "other" } });
    expect(screen.queryByTestId("op-result")).toBeNull();
  });
});

describe("server refusals are sentences", () => {
  test("stable server codes read as words, and a forbidden word names its field", () => {
    expect(describeRefusal("REQUEST_TOO_LARGE", [])).toMatch(/larger than the console accepts/);
    expect(describeRefusal("WORKFLOW_ALREADY_RUNNING", [])).toMatch(/Another run is still in progress/);
    expect(describeRefusal("INPUT_FORBIDDEN:target", runnable.inputs)).toBe(
      "Target name contains a word that is never allowed here, such as apply, destroy or auto-approve.");
    expect(describeRefusal("SOMETHING_NEW", [])).toBe("SOMETHING_NEW");
  });
});

describe("result visibility at every level", () => {
  const done = { status: "PASS" as const, operation: "probe-read", title: "Probe", evidenceBasis: runnable.evidenceBasis,
    output: "Verdict: READY\nnothing was changed" };

  test("Beginner sees a plain status sentence and the bounded output of the run they started", () => {
    card(runnable, "BEGINNER", { jobState: done });
    expect(screen.getByTestId("op-result").textContent).toMatch(/Finished — this check passed safely/);
    expect(screen.getByTestId("op-output").textContent).toMatch(/Show the result text/);
    expect(screen.getByRole("region", { name: "Result of Probe the thing" }).textContent).toBe(done.output);
    expect(screen.getByTestId("op-result").textContent).not.toMatch(/Last run: PASS/);
  });

  test("Beginner sees why a blocked run could not run, with the plain next step for a known cause", () => {
    const { unmount } = card(runnable, "BEGINNER", { jobState: { ...done, status: "BLOCKED", output: "EVIDENCE_KEY_MISSING: run ./alz doctor" } });
    expect(screen.getByTestId("op-result").textContent).toMatch(/could not run — the reason is shown below/);
    expect(screen.getByRole("region", { name: "Result of Probe the thing" }).textContent).toMatch(/EVIDENCE_KEY_MISSING/);
    unmount();
    card(runnable, "BEGINNER", { jobState: { ...done, status: "BLOCKED", blockReason: "WORKSPACE_NEEDS_BUILD", output: "WORKSPACE_NEEDS_BUILD" } });
    expect(screen.getByTestId("op-result").textContent).toMatch(/Run \.\/alz bootstrap/);
  });

  test("a running card shows no output yet, and a long output is cut to its tail", () => {
    const { unmount } = card(runnable, "BEGINNER", { jobState: { ...done, status: "RUNNING", output: "Preparing governed workflow..." } });
    expect(screen.queryByTestId("op-output")).toBeNull();
    unmount();
    card(runnable, "ADVANCED", { jobState: { ...done, output: "x".repeat(5000) + "TAIL" } });
    const text = screen.getByRole("region", { name: "Result of Probe the thing" }).textContent ?? "";
    expect(text.length).toBe(4000);
    expect(text.endsWith("TAIL")).toBe(true);
    expect(screen.getByTestId("op-result").textContent).toMatch(/Showing the last 4,000 of 5,004 characters/);
  });

  test("Advanced and Expert show the next step for a known block", () => {
    card(runnable, "ADVANCED", { jobState: { ...done, status: "BLOCKED", blockReason: "SOURCE_WORKTREE_DIRTY", output: "SOURCE_WORKTREE_DIRTY" } });
    expect(screen.getByTestId("op-next-step").textContent).toMatch(/commit or stash/);
  });

  test("a private-model card is disabled, with the reason, while the advisory check says the models are unavailable", () => {
    const live: OperationDescriptor = { ...runnable, id: "probe-live", safety: "LOCAL_MODEL", inputs: [] };
    const unavailable = { status: "UNAVAILABLE" as const, reason: "NO_LOCAL_MODEL_SERVER" as const, required: ["qwen"], missing: [] };
    const { unmount } = card(live, "BEGINNER", { modelAvailability: unavailable });
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("op-models-off").textContent).toMatch(/no local model server answered/);
    unmount();
    card(live, "BEGINNER", { modelAvailability: { ...unavailable, status: "AVAILABLE", reason: "READY" } });
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("op-models-off")).toBeNull();
  });

  test("a disabled Run button says why: another run is in progress", () => {
    card(runnable, "ADVANCED", { busy: true });
    const button = screen.getByRole("button", { name: "Run" });
    const described = (button.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described.join(" ")).toMatch(/Probe the thing.*Another run is in progress/);
  });
});

describe("handoff card", () => {
  test("explains why, has no run button, and builds the exact command from the form", () => {
    card(handoff);
    expect(screen.getByText(/A person must type the exact target in a terminal/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Run/ })).toBeNull();
    expect(screen.getByText("Complete the fields to see the command.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Target id"), { target: { value: "core-net" } });
    expect(screen.getByTestId("handoff-command").textContent).toBe("./alz teardown destroy-preview-run core-net");
    fireEvent.click(screen.getByLabelText("JSON output"));
    expect(screen.getByTestId("handoff-command").textContent).toBe("./alz teardown destroy-preview-run core-net --json");
    expect(screen.getByText("AWS_PROFILE")).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
  });

  test("an invalid value never reaches the command", () => {
    card(handoff);
    fireEvent.change(screen.getByLabelText("Target id"), { target: { value: "core net; rm -rf /" } });
    expect(screen.queryByTestId("handoff-command")).toBeNull();
  });

  test("copy writes the command to the clipboard and announces it", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    card(handoff);
    fireEvent.change(screen.getByLabelText("Target id"), { target: { value: "core-net" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("./alz teardown destroy-preview-run core-net"));
    expect((await screen.findByText(/Copied\./)).closest("[role=status]")).toBeTruthy();
  });

  test("Beginner gets the reason in plain words and no command; the viewer link opens the viewer", () => {
    const open = vi.fn();
    const { unmount } = card(handoff, "BEGINNER");
    expect(screen.getByText(/A person must type the exact target/)).toBeTruthy();
    expect(screen.queryByTestId("handoff-command")).toBeNull();
    expect(screen.queryByLabelText("Target id")).toBeNull();
    unmount();
    card(handoff, "EXPERT", { onOpenViewer: open });
    fireEvent.click(screen.getByRole("button", { name: "Review the evidence it wrote" }));
    expect(open).toHaveBeenCalledWith("probe-read");
  });
});

describe("operations entry", () => {
  const props = { csrfToken: "tok", jobState: null, busy: false, onRefresh: () => {} };

  test("Advanced loads the catalog view and navigates by family", async () => {
    render(<OperationsEntry level="ADVANCED" {...props} />);
    expect(await screen.findByText("Probe the thing")).toBeTruthy();
    const families = screen.getByRole("group", { name: "Operation families" });
    expect(families.querySelectorAll("button").length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Teardown review" }));
    expect(await screen.findByText("Preview a teardown")).toBeTruthy();
    expect(screen.queryByText("Probe the thing")).toBeNull();
  });

  test("Beginner loads nothing until asked", async () => {
    render(<OperationsEntry level="BEGINNER" {...props} />);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Browse all operations" }));
    expect(await screen.findByText("Probe the thing")).toBeTruthy();
    expect(screen.queryByText("./alz probe [aws|azure]")).toBeNull();
  });

  test("an unreachable catalog is announced", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 503 })));
    render(<OperationsEntry level="ADVANCED" {...props} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
  });
});
