/** Patterns the apply modules share, defined once. */

import type { ApplyEnvironment } from "./types.js";

/** A lowercase hex SHA-256 digest. */
export const HASH = /^[0-9a-f]{64}$/;

/** A value safe to write into generated HCL: letters, digits, dot, underscore, hyphen. */
export const SAFE_VALUE = /^[A-Za-z0-9._-]{1,128}$/;

/** An absolute path to a token file, safe to write into generated HCL. */
export const TOKEN_FILE = /^\/[A-Za-z0-9._/-]{1,512}$/;

/** The promotion stages in order: a release is applied to DEV, then QA, then PROD. */
export const ENVIRONMENTS: readonly ApplyEnvironment[] = ["DEV", "QA", "PROD"];
