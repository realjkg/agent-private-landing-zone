// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ActDev1Setup } from "../src/operator-ui/app/pilot/ActDev1Setup";
import { forgetPilotToken, setPilotToken } from "../src/operator-ui/app/pilot/pilot-api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); forgetPilotToken(); });

test("guided DEV setup explains each outstanding gate without asking for IAM expertise", () => {
  render(<ActDev1Setup />);
  fireEvent.click(screen.getByText(/Set up AWS DEV/));
  expect(screen.getByText(/Use a saved AWS connection/)).toBeTruthy();
  expect(screen.getByText(/Account not yet verified/)).toBeTruthy();
  expect(screen.getByText(/The protected change wizard below handles review/)).toBeTruthy();
  expect(screen.getByRole("button", {name:"Check AWS account"}).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("button", {name:/apply|deploy|terminate/i})).toBeNull();
});

test("account check uses existing protected pilot session and never enables cloud execution", async () => {
  setPilotToken("session-token-only");
  const calls: {path:string;options:RequestInit}[]=[];
  vi.stubGlobal("fetch",vi.fn(async (path:string,options:RequestInit) => {
    calls.push({path,options});
    return new Response(JSON.stringify({
      status:"ACCOUNT_VERIFIED",account:"111111111111",
      checks:[{name:"DEV account",status:"VERIFIED",next:"Active"}],
      action:"NONE",actEnabled:false,
    }),{status:200});
  }));
  render(<ActDev1Setup />);
  fireEvent.click(screen.getByText(/Set up AWS DEV/));
  fireEvent.change(screen.getByLabelText("DEV account number"),{target:{value:"111111111111"}});
  fireEvent.click(screen.getByRole("button",{name:"Check AWS account"}));
  await waitFor(()=>expect(screen.getByRole("status").textContent).toContain("DEV account confirmed"));
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe("/pilot/aws-readiness");
  expect(calls[0].options.method).toBe("POST");
  expect((calls[0].options.headers as Record<string,string>)["X-ALZ-Pilot-Token"]).toBe("session-token-only");
  expect(JSON.parse(calls[0].options.body as string)).toEqual({account:"111111111111",profile:"adaptcloud-admin"});
  expect(screen.getByText(/Spending, access and changes still require approval/)).toBeTruthy();
});

test("provider refusal stays blocked and shows next action", async () => {
  setPilotToken("session-token-only");
  vi.stubGlobal("fetch",vi.fn(async () => new Response(JSON.stringify({
    error:"AWS_ACCOUNT_NOT_VERIFIED",message:"blocked",
  }),{status:422})));
  render(<ActDev1Setup />);
  fireEvent.click(screen.getByText(/Set up AWS DEV/));
  fireEvent.change(screen.getByLabelText("DEV account number"),{target:{value:"111111111111"}});
  fireEvent.click(screen.getByRole("button",{name:"Check AWS account"}));
  await waitFor(()=>expect(screen.getByRole("alert").textContent).toContain("could not be verified"));
  expect(screen.getByText(/Account not yet verified/)).toBeTruthy();
});
