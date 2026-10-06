import type { IaCEngine } from "../build/types.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import type { AdapterInput } from "./input.js";

export type IaCAdapter = {
  engine: IaCEngine;
  version(
    context: ToolContext,
  ): ToolResult;
  validate(
    context: ToolContext,
    input?: AdapterInput,
  ): ToolResult[];
  preview(
    context: ToolContext,
    input?: AdapterInput,
  ): ToolResult;
};
