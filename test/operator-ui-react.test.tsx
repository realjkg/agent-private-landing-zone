// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { OperatorApp } from "../src/operator-ui/app/App";
import type { JobState } from "../src/operator-ui/app/api";
import { EXPERIENCE_LEVEL_STORAGE_KEY } from "../src/operator-ui/experience-level.js";

// D4 ports the D1 DOM ceiling to the rendered React tree: at Beginner the
// advanced/expert markup does not exist at all, and nothing anywhere carries
// hashes or policy identifiers. These assertions run against the real
// components, not the CSS-hiding of an always-full tree.
const HEX64 = /[0-9a-f]{64}/i;
const STATEMENT = /policy id|policy\.input|rego|lineage|record\.hash/i;

const jobState: JobState = {
  status: "PASS",
  title: "Offline matrix",
  evidenceBasis: "DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD",
  output: "matrix offline complete",
};

function renderApp(overrides?: Partial<Parameters<typeof OperatorApp>[0]>) {
  return render(
    <OperatorApp csrfToken="test-token" scenarioIds={["aws-brownfield"]} {...overrides} />,
  );
}

beforeEach(() => {
  // Deterministic level source: production reads localStorage; tests seed the
  // initialLevel prop where they need a specific level.
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(jobState), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("beginner ceiling (D1 port)", () => {
  test("beginner tree renders the recommended path and no run form", () => {
    renderApp({ initialLevel: "BEGINNER" });
    expect(screen.getByText("Explore governed scenarios")).toBeTruthy();
    expect(screen.getByText("Check resilience & backups")).toBeTruthy();
    expect(screen.queryByLabelText(/What would you like to do\?/)).toBeNull();
    expect(screen.queryByText("Expert reference")).toBeNull();
  });

  test("beginner tree contains no 64-hex hash or policy identifier", () => {
    const { container } = renderApp({ initialLevel: "BEGINNER", initialJobState: jobState });
    expect(HEX64.test(container.textContent ?? "")).toBe(false);
    expect(STATEMENT.test(container.textContent ?? "")).toBe(false);
  });

  test("beginner proof line translates the evidence classification in plain words", () => {
    renderApp({ initialLevel: "BEGINNER", initialJobState: jobState });
    expect(screen.getAllByText(/recorded examples/i).length).toBeGreaterThan(0);
  });
});

describe("disclosure levels", () => {
  test("advanced renders the governed run form and evidence surface", () => {
    renderApp({ initialLevel: "ADVANCED", initialJobState: jobState });
    expect(screen.getByLabelText("What would you like to do?")).toBeTruthy();
    expect(screen.getByText("Execution and evidence")).toBeTruthy();
    expect(screen.getByText(/DETERMINISTIC FIXTURE/)).toBeTruthy();
    expect(screen.queryByText("Expert reference")).toBeNull();
  });

  test("expert adds scenario ids and CLI equivalents", () => {
    renderApp({ initialLevel: "EXPERT" });
    expect(screen.getByText("Expert reference")).toBeTruthy();
    expect(screen.getByText(/Scenario ids:/)).toBeTruthy();
    expect(screen.getAllByText(/private-agent-matrix\.ts/).length).toBeGreaterThan(0);
  });

  test("level switcher persists the chosen level and re-renders in place", () => {
    renderApp({ initialLevel: "BEGINNER" });
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(window.localStorage.getItem(EXPERIENCE_LEVEL_STORAGE_KEY)).toBe("ADVANCED");
    expect(screen.getByLabelText("What would you like to do?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expert" }));
    expect(window.localStorage.getItem(EXPERIENCE_LEVEL_STORAGE_KEY)).toBe("EXPERT");
    expect(screen.getByText("Expert reference")).toBeTruthy();
  });

  test("unknown level values fall back to beginner without error", () => {
    const hostile = "GODMODE" as never; // Tampered value — must parse back to BEGINNER.
    renderApp({ initialLevel: hostile });
    expect(screen.getByText("Explore governed scenarios")).toBeTruthy();
    expect(screen.queryByLabelText(/What would you like to do\?/)).toBeNull();
  });
});

describe("server invariance (presentation-only contract)", () => {
  test("launching a run posts exactly mode, scenario, and token — never the level", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    renderApp({ initialLevel: "BEGINNER" });
    fireEvent.click(screen.getByText("Explore governed scenarios"));
    await waitFor(() => {
      // At least the /state poll, the POST /run, and the post-run refresh.
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
    const runCall = fetchMock.mock.calls.find(([url]) => url === "/run");
    expect(runCall).toBeTruthy();
    const body = new URLSearchParams(runCall?.[1]?.body as string);
    expect([...body.keys()].sort()).toEqual(["mode", "scenario", "token"]);
    expect(body.get("mode")).toBe("matrix-offline");
    expect(body.get("token")).toBe("test-token");
    expect(body.get("level")).toBeNull();
  });
});

describe("honest chrome (game-the-chrome, never the evidence)", () => {
  test("no game affordances attach to status, evidence, or policy content", () => {
    const { container } = renderApp({ initialLevel: "EXPERT", initialJobState: jobState });
    const text = container.textContent ?? "";
    // Word-bounded: "xp" must not trip over "Explore".
    const banned = /\b(score|xp|achievements?|unlocked|level up|congrats)\b/i;
    expect(banned.test(text)).toBe(false);
  });
});
