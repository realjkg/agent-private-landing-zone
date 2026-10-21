import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Validate authenticated GitHub API evidence before any registry publication. */
export function validateReleasePolicy(environment, branchPages, checkPages, source) {
  if (!/^[a-f0-9]{40}$/.test(source) || environment?.deployment_branch_policy?.custom_branch_policies !== true ||
      !environment.protection_rules?.some(rule => rule.type === 'required_reviewers' &&
        Array.isArray(rule.reviewers) && rule.reviewers.length > 0 && rule.prevent_self_review === true))
    throw new Error('RELEASE_ENVIRONMENT_UNPROTECTED');
  if (!Array.isArray(branchPages) || branchPages.some(page => !Array.isArray(page?.branch_policies)))
    throw new Error('RELEASE_BRANCH_POLICY_INVALID');
  const branches = branchPages.flatMap(page => page.branch_policies);
  if (branches.length !== 1 || branches[0].name !== 'main' || branches[0].type !== 'branch')
    throw new Error('RELEASE_BRANCH_POLICY_INVALID');
  if (!Array.isArray(checkPages) || checkPages.some(page => !Array.isArray(page?.check_runs)))
    throw new Error('RELEASE_CHECKS_INVALID');
  const checks = checkPages.flatMap(page => page.check_runs);
  for (const name of ['Linux amd64 confinement', 'Linux arm64 confinement']) {
    const candidates = checks.filter(check => check?.name === name && check.head_sha === source &&
      check.app?.slug === 'github-actions');
    if (!candidates.length || candidates.some(check => !Number.isSafeInteger(check.id)))
      throw new Error('RELEASE_CHECK_MISSING');
    const latest = candidates.reduce((a, b) => a.id > b.id ? a : b);
    if (latest.status !== 'completed' || latest.conclusion !== 'success' ||
        !/^https:\/\/github\.com\/realjkg\/agent-private-landing-zone\/actions\/runs\/[1-9][0-9]*\/job\/[1-9][0-9]*$/.test(latest.details_url ?? ''))
      throw new Error('RELEASE_CHECK_NOT_SUCCESSFUL');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const read = file => JSON.parse(readFileSync(file, 'utf8'));
  validateReleasePolicy(read('environment.json'), read('branches.json'), read('check-pages.json'), process.env.GITHUB_SHA);
  console.log('Protected main-only environment and latest native checks verified.');
}
