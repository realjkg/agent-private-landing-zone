// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { OperatorApp } from "../src/operator-ui/app/App";
import { CompliancePanels } from "../src/operator-ui/app/components/CompliancePanels";
import { CompliancePosture } from "../src/operator-ui/app/components/CompliancePosture";
import {
  ConnectorGallery,
  RECORD_CONTRACT_FIELDS,
} from "../src/operator-ui/app/components/ConnectorGallery";
import { ConnectorNotice } from "../src/operator-ui/app/components/ConnectorNotice";
import { TARGET_CONNECTORS } from "../src/integration-sim/catalog";
import { simulateConnection } from "../src/integration-sim/agent";
import { COMPLIANCE_PACKS } from "../src/compliance/packs/index.js";

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

describe("compliance posture (beginner)", () => {
  test("beginner renders the plain-language posture line naming every framework", () => {
    renderApp("BEGINNER");
    const posture = screen.getByText(/This workspace maps its safeguards to/);
    for (const framework of ["HIPAA", "PCI-DSS", "SOC 2 Type 2", "ISO 27001", "AIUC-1"]) {
      expect(posture.textContent).toContain(framework);
    }
  });

  test("beginner posture renders the disclaimer and no requirement rows", () => {
    const { container } = renderApp("BEGINNER");
    expect(screen.getAllByText(/does not establish compliance/).length).toBeGreaterThan(0);
    expect(container.querySelector("[data-requirement-id]")).toBeNull();
  });
});

describe("compliance panels (advanced/expert)", () => {
  test("advanced renders all five per-framework panels with requirement rows", () => {
    render(<CompliancePanels level="ADVANCED" />);
    for (const packId of ["HIPAA", "PCI_DSS", "SOC2_TYPE2", "ISO27001", "AIUC1"]) {
      expect(document.querySelector(`[data-pack-id="${packId}"]`)).toBeTruthy();
    }
    expect(document.querySelectorAll("[data-requirement-id]").length).toBeGreaterThan(0);
  });

  test("expert adds pack versions and requirement-to-control mapping lines", () => {
    render(<CompliancePanels level="EXPERT" />);
    const hipaaRow = document.querySelector('[data-requirement-id="HIPAA-SR-164.312(a)(1)"]');
    expect(hipaaRow?.textContent ?? "").toContain("HIPAA@1 → HIPAA-SR-164.312(a)(1)");
    expect(hipaaRow?.textContent ?? "").toContain("LEAST_PRIVILEGE");
    const encryptionRow = document.querySelector(
      '[data-requirement-id="HIPAA-SR-164.312(a)(2)(iv)"]',
    );
    expect(encryptionRow?.textContent ?? "").toContain("CUSTOMER_MANAGED_ENCRYPTION");
    expect(document.querySelector(".pack h3 code")?.textContent ?? "").toContain("@");
  });

  test("UNKNOWN requirements with no mechanisms render no fabricated evidence", () => {
    const { container } = render(<CompliancePanels level="EXPERT" />);
    const unknownRow = container.querySelector(
      '[data-requirement-id="HIPAA-SR-164.308(a)(1)"]',
    );
    expect(unknownRow?.getAttribute("data-status")).toBe("UNKNOWN");
    expect(unknownRow?.textContent ?? "").toContain("no local mechanism mapped");
  });

  test("the disclaimer stays zero interactions away at every level", () => {
    for (const level of ["BEGINNER", "ADVANCED", "EXPERT"] as const) {
      const view = render(
        level === "BEGINNER"
          ? <CompliancePosture />
          : <CompliancePanels level={level} />,
      );
      expect(screen.getAllByText(/does not establish compliance/).length).toBeGreaterThan(0);
      view.unmount();
    }
  });
});

describe("unknown-status render assertion (D3 speech rule)", () => {
  test("every UNKNOWN requirement in every pack renders Unknown and never Aligned", () => {
    const { container } = render(<CompliancePanels level="ADVANCED" />);
    let unknownRows = 0;
    for (const pack of COMPLIANCE_PACKS) {
      for (const requirement of pack.requirements) {
        const row = container.querySelector(`[data-requirement-id="${requirement.requirementId}"]`);
        expect(row).toBeTruthy();
        expect(row?.getAttribute("data-status")).toBe(requirement.status);
        const rowText = row?.textContent ?? "";
        if (requirement.status === "UNKNOWN") {
          unknownRows += 1;
          expect(rowText).toContain("Unknown");
          expect(/aligned/i.test(rowText)).toBe(false);
        } else if (requirement.status === "ALIGNED") {
          expect(rowText).toContain("Aligned");
        } else {
          expect(rowText).toContain("Gap");
        }
      }
    }
    // The sweep is only meaningful if it actually exercised UNKNOWN rows.
    expect(unknownRows).toBeGreaterThan(0);
  });

  test("expert mapping lines keep the same rule: UNKNOWN renders Unknown", () => {
    const { container } = render(<CompliancePanels level="EXPERT" />);
    const unknownRows = Array.from(
      container.querySelectorAll('.requirement-row[data-status="UNKNOWN"]'),
    );
    expect(unknownRows.length).toBeGreaterThan(0);
    for (const row of unknownRows) {
      expect(/aligned/i.test(row.textContent ?? "")).toBe(false);
      expect(row.textContent).toContain("(Unknown)");
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
