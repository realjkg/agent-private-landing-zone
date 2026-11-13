// Deterministic reference workload checks; no AWS calls or inference.
import '../reference/aws-control-tower/tests/template.test.mjs';
import '../reference/aws-control-tower/tests/handler.test.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('private API verifier shares its Lambda deadline and returns failed-check evidence', () => {
  const result = spawnSync('python3', ['-B', fileURLToPath(new URL('../reference/aws-control-tower/tests/verifier.test.py', import.meta.url))],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
