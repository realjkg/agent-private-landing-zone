import { readFileSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { OperatorApp } from "../src/operator-ui/app/App";
import { PHASE_E_SCENARIOS } from "../src/qualification/phase-e";

/**
 * Freezes the operator console's initial markup into the built shell.
 *
 * Running at build time (after `vite build`) keeps React out of the runtime:
 * the server serves a static page whose Beginner rendering ships in the HTML
 * itself, while the browser bundle takes over on mount. Scenario ids come
 * from PHASE_E_SCENARIOS here, node-side, so the qualification module graph
 * is never bundled for the browser.
 */

const SHELL_PATH = "dist/operator-ui/app/index.html";
const ROOT_MARKER = '<div id="root" data-scenario-ids=""></div>';

const scenarioIds = PHASE_E_SCENARIOS.map((scenario) => scenario.id);
for (const id of scenarioIds) {
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`PRERENDER_SCENARIO_ID_UNSAFE: ${id}`);
  }
}

const markup = renderToString(
  createElement(OperatorApp, { csrfToken: "", scenarioIds }),
);

const shell = readFileSync(SHELL_PATH, "utf8");
if (!shell.includes(ROOT_MARKER)) {
  throw new Error("PRERENDER_ROOT_MARKER_MISSING — vite shell layout changed");
}

const filled = shell.replace(
  ROOT_MARKER,
  `<div id="root" data-scenario-ids="${scenarioIds.join(",")}">${markup}</div>`,
);
writeFileSync(SHELL_PATH, filled);
console.log("prerender: operator console shell frozen with beginner markup");
