import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";

/** The files of a zip archive (Terraform's plan file), read from its central directory: stored or deflated entries only. */
export function zipEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= 0, "the plan file is a zip archive");
  let at = zip.readUInt32LE(end + 16);
  const count = zip.readUInt16LE(end + 10);
  for (let i = 0; i < count; i += 1) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50, "a central directory entry");
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28), extraLength = zip.readUInt16LE(at + 30), commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataAt, dataAt + size);
    assert.ok(method === 0 || method === 8, name + ": stored or deflated");
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

