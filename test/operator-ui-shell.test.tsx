// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { OperatorApp } from "../src/operator-ui/app/App";
import type { JobState } from "../src/operator-ui/app/api";
import { OUTPUT_DISPLAY_LIMIT } from "../src/operator-ui/app/components/EvidencePanel";
import { parseRoute } from "../src/operator-ui/app/route";

// Console shell: area navigation, focus handling, and the bounded, honest
// states every screen shares. Presentation only; none of it may change what
// the server is asked.

const idle: JobState = {
  status: "IDLE",
  title: "No workflow",
  evidenceBasis: "NOT_RUN",
  output: "No scenario executed yet.",
};

function stubFetch(state: JobState | null) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/state") return state ? new Response(JSON.stringify(state), { status: 200 }) : new Response("", { status: 403 });
    if (url === "/operations") return new Response(JSON.stringify([]), { status: 200 });
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp(level: "BEGINNER" | "ADVANCED" | "EXPERT", extra: { initialJobState?: JobState } = {}) {
  return render(<OperatorApp csrfToken="t" scenarioIds={["aws-brownfield"]} initialLevel={level} {...extra} />);
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("route parsing", () => {
  test("unknown hashes land on Home and never carry data", () => {
    expect(parseRoute("#nonsense", "operations", true).view).toBe("home");
    expect(parseRoute("", "home", false)).toEqual({ view: "home", anchor: null, navigated: false });
  });

  test("evidence keeps the operator in the current area; connectors open Reference", () => {
    expect(parseRoute("#evidence", "operations", true)).toMatchObject({ view: "operations", anchor: "evidence" });
    expect(parseRoute("#connectors", "home", true)).toMatchObject({ view: "reference", anchor: "connectors" });
  });
});

describe("shell navigation", () => {
  test("offers a skip link and one labeled navigation landmark", () => {
    stubFetch(idle);
    renderApp("ADVANCED");
    expect(screen.getByRole("link", { name: "Skip to main content" }).getAttribute("href")).toBe("#main-content");
    expect(screen.getAllByRole("navigation", { name: "Console areas" })).toHaveLength(1);
  });

  test("Reference is absent at Beginner and a stale link shows Home instead", () => {
    stubFetch(idle);
    window.location.hash = "#reference";
    renderApp("BEGINNER");
    const nav = screen.getByRole("navigation", { name: "Console areas" });
    expect(within(nav).queryByRole("link", { name: "Reference" })).toBeNull();
    expect(nav.querySelector("[aria-current=page]")?.textContent).toBe("Home");
  });

  test("moving to an area focuses its heading, and the first paint steals no focus", async () => {
    stubFetch(idle);
    renderApp("ADVANCED");
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      window.location.hash = "#operations";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(document.activeElement?.id).toBe("operations-title"));
  });

  test("the Reference area loads on demand and keeps its heading reachable", async () => {
    stubFetch(idle);
    renderApp("ADVANCED");
    expect(document.getElementById("reference-title")).toBeNull();
    await act(async () => {
      window.location.hash = "#reference";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(document.activeElement?.id).toBe("reference-title"));
  });
});

describe("states", () => {
  test("a lost session is announced as an alert outside Home", async () => {
    stubFetch(null);
    window.location.hash = "#operations";
    renderApp("ADVANCED");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/lost its local session/));
  });

  test("long output is truncated to the display bound and says so", () => {
    stubFetch(idle);
    const output = "x".repeat(OUTPUT_DISPLAY_LIMIT + 500);
    renderApp("ADVANCED", { initialJobState: { ...idle, status: "PASS", output } });
    const log = screen.getByLabelText("Run output");
    expect(log.textContent?.length).toBe(OUTPUT_DISPLAY_LIMIT);
    expect(screen.getByText(/Showing the last/)).toBeTruthy();
  });

  test("the output log is not a live region, so polling never re-announces it", () => {
    stubFetch(idle);
    renderApp("ADVANCED", { initialJobState: { ...idle, status: "RUNNING", output: "working" } });
    const log = screen.getByLabelText("Run output");
    expect(log.closest("[aria-live]")).toBeNull();
  });
});
