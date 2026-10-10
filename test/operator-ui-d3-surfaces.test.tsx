// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { OperatorApp } from "../src/operator-ui/app/App";
import {
  ConnectorGallery,
  RECORD_CONTRACT_FIELDS,
} from "../src/operator-ui/app/components/ConnectorGallery";
import { ConnectorNotice } from "../src/operator-ui/app/components/ConnectorNotice";
import { TARGET_CONNECTORS } from "../src/integration-sim/catalog";
import { simulateConnection } from "../src/integration-sim/agent";

// D3 UI — connector gallery surfaces. Component-level renders avoid the
// app shell's /state polling; App-level tests stub fetch like
// test/operator-ui-react.test.tsx does.

const jobState = {
  status: "PASS",
  title: "Offline matrix",
  evidenceBasis: "DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD",
  output: "matrix offline complete",
} as const;

function renderApp(level: "BEGINNER" | "ADVANCED" | "EXPERT") {
  return render(
    <OperatorApp csrfToken="test-token" scenarioIds={["aws-brownfield"]} initialLevel={level} />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(jobState), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("connector notice (beginner)", () => {
  test("beginner renders the single honest simulated-connectors notice", () => {
    renderApp("BEGINNER");
    expect(
      screen.getByText(
        "Cloud connectors in this preview are simulated; no external connection is made.",
      ),
    ).toBeTruthy();
  });

  test("beginner renders no gallery, no connector ids, no record contract", () => {
    const { container } = renderApp("BEGINNER");
    expect(screen.queryByText("Connector gallery")).toBeNull();
    expect(container.querySelector("[data-connector-id]")).toBeNull();
  });
});

describe("connector gallery (advanced/expert)", () => {
  test("advanced renders all fourteen connectors with literal status badges", () => {
    render(<ConnectorGallery level="ADVANCED" />);
    const cards = document.querySelectorAll("[data-connector-id]");
    expect(cards.length).toBe(TARGET_CONNECTORS.length);
    expect(document.querySelectorAll('[data-family="AGENT_BUILDER"]').length).toBe(8);
    expect(document.querySelectorAll('[data-family]:not([data-family="AGENT_BUILDER"])').length).toBe(6);
    for (const connector of TARGET_CONNECTORS) {
      const card = document.querySelector(`[data-connector-id="${connector.id}"]`);
      expect(card).toBeTruthy();
      expect(card?.textContent ?? "").toContain(connector.status);
    }
  });

  test("every simulated connector carries the synthetic-evidence label", () => {
    render(<ConnectorGallery level="ADVANCED" />);
    const simulated = document.querySelectorAll('.status-badge[data-status="SIMULATED"]');
    expect(simulated.length).toBe(8);
    for (const badge of simulated) {
      expect(badge.textContent).toContain("Simulated — synthetic evidence");
    }
  });

  test("advanced adds no manifest; expert adds manifest and the record contract", () => {
    const advanced = render(<ConnectorGallery level="ADVANCED" />);
    expect(document.querySelector(".connector-manifest")).toBeNull();
    expect(screen.queryByText(/Sovereign change record/)).toBeNull();
    advanced.unmount();

    render(<ConnectorGallery level="EXPERT" />);
    expect(document.querySelectorAll(".connector-manifest").length).toBe(TARGET_CONNECTORS.length);
    expect(document.querySelector(".record-contract")).toBeTruthy();
  });

  test("expert manifest shows loopback endpoints for simulated connectors only", () => {
    render(<ConnectorGallery level="EXPERT" />);
    for (const connector of TARGET_CONNECTORS) {
      const card = document.querySelector(`[data-connector-id="${connector.id}"]`);
      if (connector.family === "AGENT_BUILDER") {
        expect(card?.textContent ?? "").toContain("http://127.0.0.1");
      } else {
        expect(card?.textContent ?? "").toContain("no declared simulation endpoint");
      }
    }
  });
});

describe("sovereign record contract view (honesty guard)", () => {
  test("displayed invariants match what a live simulation actually emits", () => {
    const target = TARGET_CONNECTORS.find((connector) => connector.id === "AZURE_LOCAL_AI_FOUNDRY");
    if (!target) throw new Error("AZURE_LOCAL_AI_FOUNDRY missing from catalog");
    const result = simulateConnection(target, "DISCONNECTED");
    const record = result.records[0];

    for (const entry of RECORD_CONTRACT_FIELDS) {
      const actual = String(record[entry.field]);
      if (entry.field === "recordHash") {
        // The hash itself is minted by the node-side simulation; the UI
        // displays the mechanism, never a fabricated hash.
        expect(entry.invariant).not.toMatch(/[0-9a-f]{64}/i);
        expect(actual).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.invariant).toContain("sha256");
      } else {
        expect(entry.invariant).toBe(actual);
      }
    }
  });

  test("the record contract never renders a 64-hex hash as data", () => {
    const { container } = render(<ConnectorGallery level="EXPERT" />);
    expect(/[0-9a-f]{64}/i.test(container.textContent ?? "")).toBe(false);
  });
});
