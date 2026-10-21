import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReleasePolicy } from '../scripts/container-release-policy.mjs';
const source = 'a'.repeat(40);
const environment = { deployment_branch_policy: { custom_branch_policies: true },
  protection_rules: [{ type: 'required_reviewers', reviewers: [{ id: 1 }], prevent_self_review: true }] };
const branches = [{ branch_policies: [{ name: 'main', type: 'branch' }] }];
const check = (arch: string, id: number, conclusion = 'success', status = 'completed') => ({ id,
  name: `Linux ${arch} confinement`, head_sha: source, app: { slug: 'github-actions' }, conclusion, status,
  details_url: `https://github.com/realjkg/agent-private-landing-zone/actions/runs/10/job/${id}` });
const checks = [{ check_runs: [check('amd64', 1)] }, { check_runs: [check('arm64', 2)] }];
test('release gate accepts protected main-only environment and both latest authenticated native checks', () => {
  validateReleasePolicy(environment, branches, checks, source);
});
test('release gate rejects missing independent review and broad branch policies', () => {
  for (const e of [{ ...environment, protection_rules: [] },
    { ...environment, protection_rules: [{ ...environment.protection_rules[0], prevent_self_review: false }] },
    { ...environment, protection_rules: [{ ...environment.protection_rules[0], reviewers: [] }] }])
    assert.throws(() => validateReleasePolicy(e, branches, checks, source));
  for (const b of [[], [{ branch_policies: [{ name: '*', type: 'branch' }] }],
    [{ branch_policies: [{ name: 'main', type: 'tag' }] }],
    [...branches, { branch_policies: [{ name: 'other', type: 'branch' }] }]])
    assert.throws(() => validateReleasePolicy(environment, b, checks, source));
});
test('a prior success cannot mask a newer failed, pending or canceled rerun', () => {
  for (const [conclusion, status] of [['failure', 'completed'], ['', 'in_progress'], ['cancelled', 'completed']]) {
    assert.throws(() => validateReleasePolicy(environment, branches,
      [...checks, { check_runs: [check('arm64', 3, conclusion, status)] }], source), /NOT_SUCCESSFUL/);
  }
});
test('missing, wrong-source or untrusted checks cannot satisfy the release gate', () => {
  for (const replacement of [[], [{ ...check('arm64', 2), head_sha: 'b'.repeat(40) }],
    [{ ...check('arm64', 2), app: { slug: 'other-app' } }],
    [{ ...check('arm64', 2), details_url: 'https://attacker.test/success' }]]) {
    assert.throws(() => validateReleasePolicy(environment, branches,
      [checks[0], { check_runs: replacement }], source));
  }
});
