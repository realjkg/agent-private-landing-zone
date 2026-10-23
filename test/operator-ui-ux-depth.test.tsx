// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { OperatorApp } from "../src/operator-ui/app/App";
import type { JobState } from "../src/operator-ui/app/api";
import { scrollBehaviorFor } from "../src/operator-ui/app/motion";
import { PROTECTION_CARD_STORAGE_KEY } from "../src/operator-ui/app/protection-storage.js";
import { COMPLIANCE_PACKS } from "../src/compliance/packs/index.js";
import { TARGET_CONNECTORS } from "../src/integration-sim/catalog";

// UX depth pass — run feedback, section nav, summary strips, guided empty
// states. The guardrails carried over from D1–D4 stay enforced here too:
// these are presentation features, so every assertion below doubles as an
// invariance check that the presentation gained no authority.

const idleState: JobState = {
  status: "IDLE",
  title: "No workflow",
  evidenceBasis: "NOT_RUN",
  output: "No scenario executed yet.",
};

const passState: JobState = {
  status: "PASS",
  title: "ALZ eight-adapter scenario matrix",
  evidenceBasis: "DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD",
  output: "matrix offline complete",
};

function stateResponse(state: JobState): Response {
  return new Response(JSON.stringify(state), { status: 200 });
}

function renderApp(
  overrides?: Partial<Parameters<typeof OperatorApp>[0]> & {
    level?: "BEGINNER" | "ADVANCED" | "EXPERT";
  },
) {
  const { level, ...props } = overrides ?? {};
  return render(
    <OperatorApp
      csrfToken="test-token"
      scenarioIds={["aws-brownfield"]}
      initialLevel={level}
      {...props}
    />,
  );
}

function stubState(state: JobState): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) =>
    url === "/run" ? new Response("{}", { status: 202 }) : stateResponse(state),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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

describe("run feedback at the point of action", () => {
  test("the run button shows an honest running label, disabled, while in flight", async () => {
    let resolveRun: (response: Response) => void = () => {};
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/run") {
        return new Promise<Response>((resolve) => {
          resolveRun = resolve;
        });
      }
      return stateResponse(idleState);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp({ level: "ADVANCED" });

    const button = screen.getByRole("button", { name: "Run selected workflow" });
    fireEvent.click(button);

    const running = await waitFor(() =>
      screen.getByRole("button", { name: "Running…" }),
    );
    expect(running.hasAttribute("disabled")).toBe(true);
    expect(running.getAttribute("aria-busy")).toBe("true");
    expect(running.getAttribute("data-running")).toBe("true");

    resolveRun(new Response("{}", { status: 202 }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Run selected workflow" })).toBeTruthy();
    });
  });

  test("starting a run scrolls the evidence panel into view, motion-aware", async () => {
    const proto = Element.prototype as unknown as Record<string, unknown>;
    if (typeof proto.scrollIntoView !== "function") {
      proto.scrollIntoView = () => {};
    }
    const scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);

    stubState(idleState);
    renderApp({ level: "ADVANCED" });
    fireEvent.click(screen.getByRole("button", { name: "Run selected workflow" }));

    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    });
    // The scroll targets the evidence panel, not the page top.
    const target = scrollSpy.mock.instances[0] as HTMLElement | undefined;
    expect(target?.id).toBe("evidence");
  });

  test("reduced motion never gets smooth scrolling", () => {
    expect(scrollBehaviorFor(true)).toBe("auto");
    expect(scrollBehaviorFor(false)).toBe("smooth");
  });

  test("a completed run surfaces a summary line with workflow and literal result", () => {
    stubState(passState);
    renderApp({ level: "ADVANCED", initialJobState: passState });
    const summary = screen.getByTestId("run-summary");
    expect(summary.textContent).toContain("ALZ eight-adapter scenario matrix");
    expect(summary.textContent).toContain("verification PASS");
  });

  test("the summary names the scenario only when the console actually knows it", () => {
    stubState(passState);
    // No accepted run in this session (state came from a reload) — the
    // scenario clause is absent, and never guessed from the workflow title.
    renderApp({ level: "ADVANCED", initialJobState: passState });
    expect(screen.getByTestId("run-summary").textContent).not.toContain("\u00b7 scenario");
  });
});

// Open one of the console's areas the way an operator does: follow its tab.
async function openArea(name: string) {
  fireEvent.click(within(document.querySelector("nav.view-nav") as HTMLElement).getByRole("link", { name }));
  await waitFor(() => expect(document.querySelector("nav.view-nav [aria-current=page]")?.textContent).toBe(name));
}

describe("area navigation and summary strips", () => {
  test("advanced and expert offer three areas; the open one is marked current", async () => {
    for (const level of ["ADVANCED", "EXPERT"] as const) {
      stubState(idleState);
      window.location.hash = "";
      const { unmount } = renderApp({ level });
      const nav = document.querySelector("nav.view-nav") as HTMLElement;
      expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual([
        "Home", "Operations", "Pilot apply", "Reference",
      ]);
      expect(nav.querySelector("[aria-current=page]")?.textContent).toBe("Home");
      for (const id of ["workflow", "evidence"]) expect(document.getElementById(id)).toBeTruthy();
      await openArea("Reference");
      await waitFor(() => expect(document.getElementById("connectors")).toBeTruthy());
      expect(document.getElementById("compliance")).toBeTruthy();
      // Only the open area is mounted.
      expect(document.getElementById("workflow")).toBeNull();
      unmount();
    }
  });

  test("beginner offers Home, Operations and the guided Pilot apply, with no summary strip", () => {
    stubState(idleState);
    renderApp({ level: "BEGINNER" });
    const nav = document.querySelector("nav.view-nav") as HTMLElement;
    expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Home", "Operations", "Pilot apply",
    ]);
    expect(document.querySelector(".summary-strip")).toBeNull();
  });

  test("a stale reference link at beginner shows Home, never the reference detail", () => {
    stubState(idleState);
    window.location.hash = "#compliance";
    renderApp({ level: "BEGINNER" });
    expect(document.querySelector("nav.view-nav [aria-current=page]")?.textContent).toBe("Home");
    expect(document.querySelector("[data-pack-id]")).toBeNull();
  });

  test("the strip counts connectors by family and requirements by status — counts only", async () => {
    stubState(idleState);
    renderApp({ level: "ADVANCED" });
    await openArea("Reference");
    const strip = await waitFor(() => {
      const found = document.querySelector(".summary-strip");
      expect(found).toBeTruthy();
      return found;
    });
    expect(strip?.textContent).toContain("Connectors");

    const agentBuilders = TARGET_CONNECTORS.filter((c) => c.family === "AGENT_BUILDER").length;
    const environment = TARGET_CONNECTORS.length - agentBuilders;
    expect(
      strip?.querySelector('[data-connector-count="AGENT_BUILDER"] b')?.textContent,
    ).toBe(String(agentBuilders));
    expect(
      strip?.querySelector('[data-connector-count="environment"] b')?.textContent,
    ).toBe(String(environment));

    // Per-framework counts match the pack data exactly, chip by chip.
    for (const pack of COMPLIANCE_PACKS) {
      const group = strip?.querySelector(`[data-pack-counts="${pack.id}"]`);
      expect(group).toBeTruthy();
      for (const status of ["ALIGNED", "GAP", "UNKNOWN"] as const) {
        const expected = pack.requirements.filter((r) => r.status === status).length;
        const chip = group?.querySelector(`.strip-led[data-status="${status}"]`);
        expect(chip?.querySelector("b")?.textContent).toBe(String(expected));
        // The label beside the count is the literal status word.
        expect(chip?.textContent).toContain(
          { ALIGNED: "Aligned", GAP: "Gap", UNKNOWN: "Unknown" }[status],
        );
      }
    }
  });

  test("compliance pack headers carry the same counts as the strip", async () => {
    stubState(idleState);
    renderApp({ level: "ADVANCED" });
    await openArea("Reference");
    await waitFor(() => expect(document.querySelector("[data-pack-header-counts]")).toBeTruthy());
    for (const pack of COMPLIANCE_PACKS) {
      const header = document.querySelector(`[data-pack-header-counts="${pack.id}"]`);
      expect(header).toBeTruthy();
      const aligned = header?.querySelector('.strip-led[data-status="ALIGNED"] b');
      expect(aligned?.textContent).toBe(
        String(pack.requirements.filter((r) => r.status === "ALIGNED").length),
      );
      // A pack header never rewrites the vocabulary: an UNKNOWN count chip
      // says Unknown, never Aligned.
      const unknownChip = header?.querySelector('.strip-led[data-status="UNKNOWN"]');
      expect(unknownChip?.textContent).toContain("Unknown");
    }
  });
});

describe("guided empty states and first-run", () => {
  test("the evidence panel guides instead of showing IDLE / NOT_RUN before any run", () => {
    stubState(idleState);
    renderApp({ level: "ADVANCED" });
    expect(screen.getByText("No run yet — here is what one produces.")).toBeTruthy();
    // The bare machine-state strings are gone from the panel.
    expect(screen.queryByText("IDLE")).toBeNull();
    expect(screen.queryByText("No scenario executed yet.")).toBeNull();
    expect(screen.queryByText("NOT_RUN")).toBeNull();
  });

  test("real signals keep the literal display: PASS shows LED and evidence basis", () => {
    stubState(passState);
    renderApp({ level: "ADVANCED", initialJobState: passState });
    expect(screen.getByTestId("run-summary")).toBeTruthy();
    expect(screen.getByText("PASS")).toBeTruthy();
    expect(screen.getByText(/DETERMINISTIC FIXTURE/)).toBeTruthy();
    expect(screen.queryByTestId("evidence-empty")).toBeNull();
  });

  test("the beginner protection card offers three honest bullets and dismisses once", () => {
    stubState(idleState);
    const { unmount } = renderApp({ level: "BEGINNER" });
    const card = document.querySelector(".protection-card");
    expect(card).toBeTruthy();
    expect(card?.querySelectorAll(".protection-points li").length).toBe(3);
    expect(card?.textContent).toContain("Local session");
    expect(card?.textContent).toContain("Sample evidence");
    expect(card?.textContent).toContain("Changes disabled");
    const disclosures = card?.querySelectorAll(".protection-points details");
    expect(disclosures?.length).toBe(3);
    expect([...disclosures!].every((item) => !item.open)).toBe(true);
    expect(card?.textContent).toContain("recorded test data, not live cloud evidence");
    expect(card?.textContent).toContain("requires owner authorization, approvals");
    fireEvent.click(disclosures![0]!.querySelector("summary")!);
    expect(disclosures![0]!.open).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(window.localStorage.getItem(PROTECTION_CARD_STORAGE_KEY)).toBe("1");
    expect(document.querySelector(".protection-card")).toBeNull();

    // One-time: a fresh mount stays dismissed.
    unmount();
    renderApp({ level: "BEGINNER" });
    expect(document.querySelector(".protection-card")).toBeNull();
  });

  test("the protection card renders only at beginner", () => {
    stubState(idleState);
    renderApp({ level: "ADVANCED" });
    expect(document.querySelector(".protection-card")).toBeNull();
  });
});
