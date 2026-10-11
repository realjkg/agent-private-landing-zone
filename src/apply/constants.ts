/** Patterns the apply modules share, defined once. */

/** A lowercase hex SHA-256 digest. */
export const HASH = /^[0-9a-f]{64}$/;

/** A GUID, in either case (tenant, subscription and client ids). */
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A value safe to write into generated HCL: letters, digits, dot, underscore, hyphen. */
export const SAFE_VALUE = /^[A-Za-z0-9._-]{1,128}$/;
