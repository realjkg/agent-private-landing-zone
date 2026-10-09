import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalOperatorServer } from "../operator-ui/server.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { server } = createLocalOperatorServer({ root });
const port = Number.parseInt(process.env.ALZ_OPERATOR_PORT ?? "8788", 10);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("ALZ_OPERATOR_PORT must be an unprivileged local TCP port");
}
server.listen(port, "127.0.0.1", () => {
  console.log("Sovereign ALZ — local browser workspace");
  console.log("Open http://127.0.0.1:" + port + " on this machine.");
  console.log("ACT DISABLED; synthetic scenarios require no cloud access.");
  console.log("Ctrl+C ends the local session.");
});
