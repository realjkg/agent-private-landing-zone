import { createRoot } from "react-dom/client";

import { OperatorApp } from "./App";
import "./styles/theme.css";
import "./styles/retro.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("CONSOLE_ROOT_MISSING");

// The CSRF token is injected by the local server into the carrier input next
// to #root; it never travels any other way. Scenario ids are frozen into the
// root data attribute at build time (scripts/prerender-ui.tsx) so the heavy
// qualification modules stay out of the browser bundle.
const csrfToken =
  document.querySelector<HTMLInputElement>("input[data-operator-csrf]")?.value ?? "";
const scenarioIds = (rootElement.dataset.scenarioIds ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

createRoot(rootElement).render(<OperatorApp csrfToken={csrfToken} scenarioIds={scenarioIds} />);
