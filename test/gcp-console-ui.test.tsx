// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { OPERATIONS } from "../src/operations/registry.js";
import type { OperationDescriptor } from "../src/operations/types.js";
import { OperationCard } from "../src/operator-ui/app/operations/OperationCard";

const source = OPERATIONS.find((spec) => spec.id === "demo-gcp-offline");
if (!source) throw new Error("GCP_DEMO_NOT_REGISTERED");

const spec: OperationDescriptor = {
  id: source.id,
  title: source.title,
  summary: source.summary,
  family: source.family,
  cli: source.cli,
  safety: source.safety,
  inputs: source.inputs,
  evidenceBasis: source.evidenceBasis,
  runnable: true,
};
const renderCard = () => render(
  <OperationCard
    spec={spec}
    level="EXPERT"
    csrfToken="synthetic-csrf"
    jobState={null}
    busy={false}
    onRefresh={async () => {}}
    onOpenViewer={() => {}}
    modelAvailability={{ status: "UNAVAILABLE", reason: "NO_LOCAL_MODEL_SERVER", required: [], missing: [] }}
  />,
);

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("operator UI presents GCP as an explicitly synthetic, read-only fixture instead of an ACT workflow", () => {
  renderCard();
  const card = document.getElementById("op-demo-gcp-offline");
  expect(card).not.toBeNull();
  const area = within(card as HTMLElement);
  expect(area.getByRole("heading", { name: "GCP offline landing-zone walkthrough" })).toBeTruthy();
  expect(area.getByText("./alz demo gcp terraform")).toBeTruthy();
  expect((card?.textContent ?? "")).toContain("SYNTHETIC");
  expect((card?.textContent ?? "")).toContain("NO AUTH, LIVE CLOUD, MODEL, TERRAFORM PLAN OR ACT");
  const choices = area.getByRole("combobox", { name: "Environment scenario" }) as HTMLSelectElement;
  expect([...choices.options].map((o) => o.value)).toEqual(["brownfield", "greenfield", "unknown"]);
  expect(area.getByRole("button", { name: "Run" })).toBeTruthy();
  expect(area.queryByRole("button", { name: /apply|deploy|destroy|approve/i })).toBeNull();
});

test("GCP UI submits only the pinned synthetic scenario and CSRF token; never credentials or cloud authority", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status: 202 });
  }));
  renderCard();
  const card = document.getElementById("op-demo-gcp-offline") as HTMLElement;
  fireEvent.change(within(card).getByRole("combobox", { name: "Environment scenario" }), { target: { value: "unknown" } });
  fireEvent.click(within(card).getByRole("button", { name: "Run" }));
  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0]?.url).toBe("/run");
  expect(calls[0]?.init?.method).toBe("POST");
  const params = new URLSearchParams(calls[0]?.init?.body as string);
  expect([...params.keys()].sort()).toEqual(["inputs", "operation", "token"]);
  expect(params.get("operation")).toBe("demo-gcp-offline");
  expect(params.get("token")).toBe("synthetic-csrf");
  expect(JSON.parse(params.get("inputs") ?? "{}")).toEqual({ mock: "unknown" });
  expect((calls[0]?.init?.body as URLSearchParams).toString()).not.toMatch(/credential|accessToken|cloudRead|allowMutation|apply/i);
});
