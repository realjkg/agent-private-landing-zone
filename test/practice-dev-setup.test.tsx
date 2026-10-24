// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PracticeDevSetup } from "../src/operator-ui/app/operations/PracticeDevSetup";
import { COMMON_DEV_GATES, PRACTICE_ROLES } from "../src/account-factory/practice-roles.js";

afterEach(() => cleanup());

test("all four practices see role-specific customer DEV prerequisites", () => {
  render(<PracticeDevSetup />);
  fireEvent.click(screen.getByRole("button", { name: "Start a customer DEV environment" }));
  const chooser = screen.getByLabelText("Your practice and role") as HTMLSelectElement;
  expect(chooser.options.length).toBe(4);
  for (const role of PRACTICE_ROLES) {
    fireEvent.change(chooser, { target: { value: role.id } });
    expect(screen.getByText(role.focus)).toBeTruthy();
    expect(screen.getByText(role.handoff)).toBeTruthy();
    for (const item of role.prerequisites) expect(screen.getByText(item)).toBeTruthy();
  }
  for (const item of COMMON_DEV_GATES) expect(screen.getByText(item)).toBeTruthy();
});

test("role selection never authorizes creation or invites credentials", () => {
  render(<PracticeDevSetup />);
  fireEvent.click(screen.getByText("Start a customer DEV environment"));
  expect(screen.getByText(/Selecting a role here never grants AWS access/)).toBeTruthy();
  expect(screen.getByText(/These cards currently provide terminal handoffs/)).toBeTruthy();
  expect(screen.getByText(/QA\/PROD remain separate gated environments/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /submit|create account|deploy|apply/i })).toBeNull();
});
