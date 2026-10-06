import type { IaCEngine } from "../build/types.js";
import { bicepAdapter } from "./bicep.js";
import { cloudformationAdapter } from "./cloudformation.js";
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

  if (engine === "PULUMI") {
    return pulumiAdapter;
  }

  if (engine === "BICEP") {
    return bicepAdapter;
  }

  if (engine === "CLOUDFORMATION") {
    return cloudformationAdapter;
  }

  throw new Error(
    "IAC_ADAPTER_NOT_IMPLEMENTED: " +
      engine,
  );
}
