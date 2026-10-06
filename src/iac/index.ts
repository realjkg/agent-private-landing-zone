import type { IaCEngine } from "../build/types.js";
import { opentofuAdapter } from "./opentofu.js";
import { pulumiAdapter } from "./pulumi.js";
import { terraformAdapter } from "./terraform.js";
import type { IaCAdapter } from "./types.js";

export function getIaCAdapter(
  engine: IaCEngine,
): IaCAdapter {
  if (engine === "TERRAFORM") {
    return terraformAdapter;
  }

  if (engine === "OPENTOFU") {
    return opentofuAdapter;
  }

  return pulumiAdapter;
}
