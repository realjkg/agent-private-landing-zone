import type { PilotChannel } from "./types.js";

/** Plain language, one place: the driver, the terminal CLI and the console wizard all show it. Nothing was consumed when it is shown. */
export const channelMismatchMessage = (sealedIn: PilotChannel): string => sealedIn === "UI"
  ? "This change was started in the web console, so it has to be finished in the web console. It cannot be approved or applied from the command line. Nothing was used up. Open the console, or start a new change on the command line."
  : "This change was started on the command line, so it has to be finished on the command line. It cannot be approved or applied from the web console. Nothing was used up. Use the command line, or start a new change in the console.";
