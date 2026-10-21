// Runs only inside the explicit, disposable native CI qualification container.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire('/app/package.json');
const expected = process.env.QUALIFICATION_ARCH;
assert.equal(process.platform, 'linux');
assert.equal(process.arch, expected === 'amd64' ? 'x64' : expected);
assert.match(process.env.ALZ_SOURCE_COMMIT ?? '', /^[a-f0-9]{40}$/);
const status = readFileSync('/proc/self/status', 'utf8');
const profile = readFileSync('/proc/self/attr/current', 'utf8').trim();
assert.match(status, /^Seccomp:\s+2$/m);
assert.match(status, /^NoNewPrivs:\s+1$/m);
assert.match(profile, /^alz-runtime \(enforce\)$/);
const Database = require('better-sqlite3');
const db = new Database('/app/.runs/probe.db');
try { db.exec('create table probe (value integer)'); db.prepare('insert into probe values (?)').run(1);
  assert.equal(db.prepare('select value from probe').get().value, 1);
} finally { db.close(); }
writeFileSync('/app/.runs/probe.json', JSON.stringify({ source: process.env.ALZ_SOURCE_COMMIT, sqlite: true }));
writeFileSync('/tmp/probe.txt', 'temporary write');
const child = spawnSync(process.execPath, ['-e', 'process.stdout.write("NODE_CHILD_OK")'], { encoding: 'utf8' });
assert.equal(child.status, 0, child.stderr);
assert.equal(child.stdout, 'NODE_CHILD_OK');
for (const path of ['/app/forbidden', '/proc/sys/kernel/hostname', '/usr/local/forbidden']) {
  assert.throws(() => writeFileSync(path, 'forbidden'));
}
assert.ok(spawnSync('/bin/sh', ['-c', 'true']).error);
const report = { sourceCommit: process.env.ALZ_SOURCE_COMMIT, architecture: process.arch,
  apparmor: profile, seccomp: 2, noNewPrivileges: true,
  checks: ['SQLITE_EVIDENCE_WRITE', 'TEMP_WRITE', 'NODE_CHILD', 'ROOT_WRITE_DENIED', 'KERNEL_WRITE_DENIED', 'UNDECLARED_WRITE_DENIED', 'SHELL_EXEC_DENIED'],
  passed: true, productionReleaseApproved: false };
process.stdout.write(JSON.stringify(report) + '\n');
