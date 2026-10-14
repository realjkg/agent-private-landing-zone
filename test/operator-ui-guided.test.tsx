// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { DeploymentContext } from "../src/operator-ui/app/components/DeploymentContext";
import { PLUGIN_CATALOG } from "../src/plugins/catalog.js";

afterEach(() => cleanup());

test("operator UI exposes Development, Staging and Production as distinct advisory targets", () => {
  render(<DeploymentContext />);
  const stage = screen.getByRole("combobox", { name: "Environment" }) as HTMLSelectElement;
  const provider = screen.getByRole("combobox", { name: "Cloud or private platform" }) as HTMLSelectElement;
  expect([...stage.options].map((option) => option.value)).toEqual(["development", "staging", "production"]);
  expect([...provider.options].map((option) => option.value)).toEqual(["aws", "azure", "gcp", "private"]);
  expect(screen.getByText(/planning view; it does not connect/)).toBeTruthy();
  fireEvent.change(stage, { target: { value: "staging" } });
  expect(screen.getByRole("status").textContent).toContain("cannot be promoted automatically");
  fireEvent.change(stage, { target: { value: "production" } });
  expect(screen.getByRole("status").textContent).toContain("formal promotion");
  fireEvent.change(provider, { target: { value: "gcp" } });
  expect(screen.getByText(/live GCP onboarding is not qualified/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /deploy|approve|apply|destroy/i })).toBeNull();
});

test("Crossplane remains a registered engine even when its executable has not been installed", () => {
  const plugin = PLUGIN_CATALOG.find((item) => item.id === "CROSSPLANE");
  expect(plugin?.status).toBe("IMPLEMENTED");
  expect(plugin?.executable).toBe("crossplane");
  expect(plugin?.stage).toContain("BUILD");
});
