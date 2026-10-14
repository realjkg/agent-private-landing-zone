// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { MockBoundaryLab } from "../src/operator-ui/app/components/MockBoundaryLab";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("browser mockup presents synthetic cloud auth and ACT review without POST, credentials or enabled ACT", () => {
  const spy = vi.fn(() => Promise.reject(new Error("NETWORK_MUST_NOT_BE_USED")));
  vi.stubGlobal("fetch", spy);
  render(<MockBoundaryLab platform="gcp" stage="production" />);
  const region = screen.getByTestId("mock-boundary-lab");
  expect(region.textContent).toContain("SYNTHETIC ONLY");
  fireEvent.click(screen.getByText("Simulate cloud sign-in and approval safety (no real connections)"));
  expect(region.textContent).toContain("No credentials, network requests");
  const auth = screen.getByRole("combobox", { name: "Mock cloud sign-in" });
  const approval = screen.getByRole("combobox", { name: "Mock ACT approval" });
  expect(screen.getByTestId("mock-boundary-result").textContent).toContain("DENIED_ACT_DISABLED");
  fireEvent.change(auth, { target: { value: "EXPIRED_FIXTURE" } });
  expect(screen.getByTestId("mock-boundary-result").textContent).toContain("SYNTHETIC_AUTH_REJECTED");
  fireEvent.change(auth, { target: { value: "WRONG_SCOPE_FIXTURE" } });
  expect(screen.getByTestId("mock-boundary-result").textContent).toContain("SYNTHETIC_AUTH_REJECTED");
  fireEvent.change(auth, { target: { value: "VALID_FIXTURE" } });
  fireEvent.change(approval, { target: { value: "MODEL_REQUEST_FIXTURE" } });
  expect(screen.getByTestId("mock-boundary-result").textContent).toContain("MODEL_HAS_NO_AUTHORITY");
  expect(screen.getByTestId("mock-boundary-result").textContent).toContain("DENIED_ACT_DISABLED");
  fireEvent.change(approval, { target: { value: "HUMAN_APPROVAL_FIXTURE" } });
  expect(screen.getByTestId("mock-boundary-result").textContent).toContain("HUMAN_FIXTURE_ONLY");
  expect(screen.getByTestId("mock-boundary-result").textContent).toContain("DENIED_ACT_DISABLED");
  expect(region.querySelector("button")).toBeNull();
  expect(spy).not.toHaveBeenCalled();
});
