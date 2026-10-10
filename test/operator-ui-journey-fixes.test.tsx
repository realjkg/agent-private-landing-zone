// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { OperatorApp } from "../src/operator-ui/app/App";
import type { JobState, ModelAvailability } from "../src/operator-ui/app/api";
import { scrollIntoViewSafe } from "../src/operator-ui/app/motion";

// Fixes from the end-to-end journey pass: an honest resilience summary,
// private-model workflows that reflect this machine, and run auto-scroll that
// actually moves the page. Presentation only — every test here also checks
// that nothing gained authority (POST /run still carries mode, scenario and
// token, and the server still validates every run).

const idleState: JobState = {
  status: "IDLE",
  title: "No workflow",
  evidenceBasis: "NOT_RUN",
  output: "No scenario executed yet.",
};

const resiliencePass: JobState = {
  status: "PASS",
  title: "Chaos and Well-Architected pillars",
  evidenceBasis: "SYNTHETIC FAULT INJECTION — no real restore or cloud mutation",
  output: "Recovery verification: BLOCKED",
  recoveryVerification: "BLOCKED",
};

const matrixPass: JobState = {
  status: "PASS",
  title: "ALZ eight-adapter scenario matrix",
  evidenceBasis: "DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD",
  output: "matrix offline complete",
};

const noServer: ModelAvailability = {
  status: "UNAVAILABLE",
  reason: "NO_LOCAL_MODEL_SERVER",
  required: ["qwen3:1.7b", "qwen3:4b", "mistral-nemo:latest"],
  missing: [],
};

function stub(state: JobState, models: ModelAvailability | null | (() => ModelAvailability)) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/run") return new Response("{}", { status: 202 });
    if (url === "/models") {
      if (models === null) return new Response("{}", { status: 404 });
      const body = typeof models === "function" ? models() : models;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify(state), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp(level: "BEGINNER" | "ADVANCED" | "EXPERT", initialJobState?: JobState) {
  return render(
    <OperatorApp
      csrfToken="test-token"
      scenarioIds={["aws-brownfield"]}
      initialLevel={level}
      initialJobState={initialJobState}
    />,
  );
}

const option = (value: string) =>
  document.querySelector<HTMLOptionElement>(`#mode option[value="${value}"]`);

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resilience results never read as recovery proven", () => {
  test("the summary separates contained faults from recovery verification", () => {
    stub(resiliencePass, null);
    renderApp("ADVANCED", resiliencePass);
    const summary = screen.getByTestId("run-summary").textContent ?? "";
    expect(summary).toContain("all applicable simulated faults contained");
    expect(summary).toContain("recovery verification BLOCKED");
    expect(summary).toContain("no real restore run");
    expect(summary).not.toContain("verification PASS");
  });

  test("other workflows keep the literal verification result", () => {
    stub(matrixPass, null);
    renderApp("ADVANCED", matrixPass);
    const summary = screen.getByTestId("run-summary").textContent ?? "";
    expect(summary).toContain("verification PASS");
    expect(summary).not.toContain("recovery verification");
  });

  test("beginner hears that real backup recovery was not tested", () => {
    stub(resiliencePass, null);
    renderApp("BEGINNER", resiliencePass);
    const status = document.querySelector(".beginner-status")?.textContent ?? "";
    expect(status).toContain("every simulated fault was caught");
    expect(status).toContain("Real backup recovery was not tested");
    expect(status).not.toContain("passed safely");
  });

  test("beginner matrix PASS keeps its existing line", () => {
    stub(matrixPass, null);
    renderApp("BEGINNER", matrixPass);
    expect(document.querySelector(".beginner-status")?.textContent).toBe(
      "Finished — this check passed safely",
    );
  });
});

describe("private-model workflows reflect this machine", () => {
  test("without a local model server they are disabled and the note says why", async () => {
    stub(idleState, noServer);
    renderApp("ADVANCED");
    await waitFor(() => expect(option("matrix-live")?.disabled).toBe(true));
    expect(option("aws-review")?.disabled).toBe(true);
    expect(option("matrix-live")?.textContent).toContain("(needs local models)");
    // Offline and resilience workflows are untouched.
    expect(option("matrix-offline")?.disabled).toBe(false);
    expect(option("chaos")?.disabled).toBe(false);
    const note = screen.getByTestId("model-note").textContent ?? "";
    expect(note).toContain("no local model server answered");
    expect(note).toContain("qwen3:1.7b, qwen3:4b, mistral-nemo:latest");
  });

  test("missing models are named from the server's answer", async () => {
    stub(idleState, { ...noServer, reason: "MODELS_NOT_INSTALLED", missing: ["mistral-nemo:latest"] });
    renderApp("ADVANCED");
    const note = await waitFor(() => screen.getByTestId("model-note"));
    expect(note.textContent).toContain("not installed — mistral-nemo:latest");
  });

  test("available models, or an unknown answer, leave every workflow offered", async () => {
    for (const models of [{ ...noServer, status: "AVAILABLE", reason: "READY" } as const, null]) {
      const fetchMock = stub(idleState, models);
      const { unmount } = renderApp("ADVANCED");
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([url]) => url === "/models")).toBe(true));
      expect(option("matrix-live")?.disabled).toBe(false);
      expect(option("aws-review")?.disabled).toBe(false);
      expect(screen.queryByTestId("model-note")).toBeNull();
      unmount();
    }
  });

  test("a private-model pick made before the probe answers falls back to offline", async () => {
    let answer: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/models") {
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      }
      return new Response(JSON.stringify(idleState), { status: 200 });
    }));
    renderApp("ADVANCED");
    const select = document.querySelector<HTMLSelectElement>("#mode")!;
    // The probe has not answered yet, so the option is still offered.
    fireEvent.change(select, { target: { value: "matrix-live" } });
    expect(select.value).toBe("matrix-live");
    answer(new Response(JSON.stringify(noServer), { status: 200 }));
    await waitFor(() => expect(option("matrix-live")?.disabled).toBe(true));
    expect(select.value).toBe("matrix-offline");
  });

  test("check again re-probes and re-enables once models are installed", async () => {
    let models: ModelAvailability = noServer;
    const fetchMock = stub(idleState, () => models);
    renderApp("ADVANCED");
    const recheck = await waitFor(() => screen.getByRole("button", { name: "Check again" }));
    models = { ...noServer, status: "AVAILABLE", reason: "READY" };
    fireEvent.click(recheck);
    await waitFor(() => expect(option("matrix-live")?.disabled).toBe(false));
    expect(screen.queryByTestId("model-note")).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/models").length).toBe(2);
  });

  test("the run request is unchanged: mode, scenario and token only", async () => {
    const fetchMock = stub(idleState, noServer);
    renderApp("ADVANCED");
    await waitFor(() => expect(option("matrix-live")?.disabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Run selected workflow" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/run")).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/run")! as unknown as
      [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect([...body.keys()].sort()).toEqual(["mode", "scenario", "token"]);
    expect(body.get("mode")).toBe("matrix-offline");
  });
});

describe("run auto-scroll", () => {
  test("the scroll starts on the next animation frame, not inside the click", () => {
    const element = document.createElement("section");
    const scroll = vi.fn();
    element.scrollIntoView = scroll;
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    scrollIntoViewSafe(element, "smooth");
    expect(scroll).not.toHaveBeenCalled();
    frames.forEach((callback) => callback(0));
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  test("missing elements or scrollIntoView skip silently", () => {
    expect(() => scrollIntoViewSafe(null, "auto")).not.toThrow();
  });
});

const dirtyBlocked: JobState = {
  status: "BLOCKED",
  title: "ALZ eight-adapter scenario matrix",
  evidenceBasis: "DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD",
  output: "WORKFLOW_BLOCKED_EXIT_1\nMATRIX_BLOCKED: SOURCE_WORKTREE_DIRTY",
  blockReason: "SOURCE_WORKTREE_DIRTY",
};

describe("blocked runs explain local setup states", () => {
  test("beginner hears why and what to do, without switching level", () => {
    stub(dirtyBlocked, null);
    renderApp("BEGINNER", dirtyBlocked);
    const status = document.querySelector(".beginner-status")?.textContent ?? "";
    expect(status).toContain("This check could not run.");
    expect(status).toContain("uncommitted changes");
    expect(status).toContain("commit or stash");
    expect(status).not.toContain("switch to Advanced");
  });

  test("advanced keeps the literal diagnostic and adds the next step", () => {
    stub(dirtyBlocked, null);
    renderApp("ADVANCED", dirtyBlocked);
    expect(screen.getByTestId("run-summary").textContent).toContain("verification BLOCKED");
    expect(screen.getByText(/MATRIX_BLOCKED: SOURCE_WORKTREE_DIRTY/)).toBeTruthy();
    expect(screen.getByTestId("run-next-step").textContent).toContain("commit or stash");
  });

  test("a missing build points at bootstrap", () => {
    const needsBuild: JobState = { ...dirtyBlocked, output: "WORKSPACE_NEEDS_BUILD",
      blockReason: "WORKSPACE_NEEDS_BUILD" };
    stub(needsBuild, null);
    renderApp("ADVANCED", needsBuild);
    expect(screen.getByTestId("run-next-step").textContent).toContain("./alz bootstrap");
  });

  test("unknown blocks keep the existing wording and get no invented advice", () => {
    const unknown: JobState = { ...dirtyBlocked, output: "QUALIFICATION_BLOCKED: fetch failed" };
    delete unknown.blockReason;
    stub(unknown, null);
    const { unmount } = renderApp("BEGINNER", unknown);
    expect(document.querySelector(".beginner-status")?.textContent).toBe(
      "This check could not run — switch to Advanced for the technical reason",
    );
    unmount();
    renderApp("ADVANCED", unknown);
    expect(screen.queryByTestId("run-next-step")).toBeNull();
  });
});

describe("live regions announce changes only", () => {
  test("static beginner text is not a live region; the run status still is", () => {
    stub(idleState, null);
    renderApp("BEGINNER");
    for (const label of ["Cloud connectors", "Compliance posture"]) {
      const section = screen.getByRole("region", { name: label });
      expect(section.querySelector("[aria-live], [role=status]")).toBeNull();
    }
    const status = document.querySelector(".beginner-status");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
  });

  test("the streaming output log is not re-announced on every poll", () => {
    stub(matrixPass, null);
    renderApp("ADVANCED", matrixPass);
    const output = document.querySelector("#evidence .output");
    expect(output).toBeTruthy();
    expect(output?.hasAttribute("aria-live")).toBe(false);
    // Outcomes are still announced by the summary line.
    expect(screen.getByTestId("run-summary").getAttribute("aria-live")).toBe("polite");
  });
});
