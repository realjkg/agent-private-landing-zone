import type { BlockReason } from "./api.js";

/**
 * Plain-language next steps for blocked runs whose cause is a local setup
 * state the operator can fix. Shared by every level so the advice never
 * diverges. Explains a block; never relaxes it — the workflow still refuses
 * until the state is fixed.
 */
export const BLOCK_REASON_NEXT_STEPS: Readonly<Record<BlockReason, string>> = {
  SOURCE_WORKTREE_DIRTY:
    "This workspace folder has uncommitted changes. Runs need a clean commit so their " +
    "evidence names exactly what ran — commit or stash the changes, then try again.",
  WORKSPACE_NEEDS_BUILD:
    "The workspace is not fully set up yet. Run ./alz bootstrap, restart the workspace, " +
    "then try again.",
};
