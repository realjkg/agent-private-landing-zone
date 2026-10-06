import type {
  IaCEngine,
} from "../build/types.js";
import { bicepAdapter } from "./bicep.js";
import { cloudformationAdapter } from "./cloudformation.js";
import { opentofuAdapter } from "./opentofu.js";
import { pulumiAdapter } from "./pulumi.js";
import { terraformAdapter } from "./terraform.js";
import type { IaCAdapter } from "./types.js";

const adapters: Partial<
  Record<IaCEngine, IaCAdapter>
> = {
  TERRAFORM: terraformAdapter,
  PULUMI: pulumiAdapter,
  OPENTOFU: opentofuAdapter,
  BICEP: bicepAdapter,
  CLOUDFORMATION: cloudformationAdapter,
};

export function hasIaCAdapter(
  engine: IaCEngine,
): boolean {
  return Boolean(adapters[engine]);
}

export function getIaCAdapter(
  engine: IaCEngine,
): IaCAdapter {
  const adapter = adapters[engine];

  if (!adapter) {
    throw new Error(
      "IAC_ADAPTER_NOT_IMPLEMENTED: " +
        engine,
    );
  }

  return adapter;
}
