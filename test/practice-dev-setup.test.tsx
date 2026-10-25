// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PracticeDevSetup } from "../src/operator-ui/app/operations/PracticeDevSetup";
import { COMMON_DEV_GATES, PRACTICE_ROLES } from "../src/account-factory/practice-roles.js";

afterEach(() => cleanup());

test("four practice users see their own AWS access and setup checklist", () => {
  render(<PracticeDevSetup />);
  fireEvent.click(screen.getByRole("button", { name: "Create a customer environment" }));
  const chooser = screen.getByLabelText("Your practice") as HTMLSelectElement;
  expect(chooser.options.length).toBe(4);
  for (const role of PRACTICE_ROLES) {
    fireEvent.change(chooser, { target: { value: role.id } });
    expect(screen.getByRole("status").textContent).toContain(role.focus);
    expect(screen.getByText(role.handoff)).toBeTruthy();
    for (const item of role.prerequisites) expect(screen.getByText(item)).toBeTruthy();
  }
  for (const item of COMMON_DEV_GATES) expect(screen.getByText(item)).toBeTruthy();
});

test("DEV QA STAGING PROD selectable, browser cannot silently create accounts", () => {
  render(<PracticeDevSetup />);
  fireEvent.click(screen.getByText("Create a customer environment"));
  const field = screen.getByLabelText("Environment") as HTMLSelectElement;
  expect(field.value).toBe("DEV");
  for (const env of ["QA", "STAGING", "PROD"]) {
    fireEvent.change(field, { target: { value: env } });
    expect(screen.getByRole("status").textContent).toContain("Selected environment: " + env);
  }
  expect(screen.getByText(/No new ALZ role/)).toBeTruthy();
  expect(screen.getByText(/The browser does not silently/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /submit|deploy|apply/i })).toBeNull();
});
