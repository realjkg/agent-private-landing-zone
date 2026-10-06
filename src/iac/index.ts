import type { IaCEngine } from "../build/types.js";
import { pulumiAdapter } from "./pulumi.js";
import { terraformAdapter } from "./terraform.js";
import type { IaCAdapter } from "./types.js";

export function getIaCAdapter(
  engine: IaCEngine,
): IaCAdapter {
  if (engine === "TERRAFORM") {
    return terraformAdapter;
  }

  return pulumiAdapter;
}
