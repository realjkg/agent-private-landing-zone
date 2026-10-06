import type { IaCEngine } from "../build/types.js";
import type { ToolContext, ToolResult } from "../tools/types.js";

export type IaCAdapter = {
  engine: IaCEngine;
  version(
    context: ToolContext,
  ): ToolResult;
  validate(
    context: ToolContext,
  ): ToolResult[];
  preview(
    context: ToolContext,
  ): ToolResult;
};
