/** Patterns the apply modules share, defined once. */

import type { ApplyEnvironment } from "./types.js";

/** A lowercase hex SHA-256 digest. */
export const HASH = /^[0-9a-f]{64}$/;

/** A GUID, in either case (tenant, subscription and client ids). */
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A value safe to write into generated HCL: letters, digits, dot, underscore, hyphen. */
export const SAFE_VALUE = /^[A-Za-z0-9._-]{1,128}$/;

/** The promotion stages in order: a release is applied to DEV, then QA, then PROD. */
export const ENVIRONMENTS: readonly ApplyEnvironment[] = ["DEV", "QA", "PROD"];
