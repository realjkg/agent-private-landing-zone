import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { signer, predicateType, workflow, baseMaterials, validateProvenance, validateImageIndex, repository, sourceRepository } from './container-signature.mjs';

const [image, source] = process.argv.slice(2);
if (process.env.GITHUB_SHA !== source || process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_WORKFLOW_REF !== workflow) throw new Error('PROVENANCE_SOURCE_INVALID');
const lock = JSON.parse(readFileSync('config/container-bases.json', 'utf8'));
const platform = process.env.RELEASE_PLATFORM;
if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('PROVENANCE_PLATFORM_INVALID');
const version = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 15000 }).trim();
let index = readFileSync('release-index.json');
let nativeManifestDigest;
try { nativeManifestDigest = validateImageIndex(index, image, platform); }
catch (error) {
  // buildx may append one newline; accept only bytes matching the subject hash.
  if (index.at(-1) !== 10) throw error;
  index = index.subarray(0, -1);
  nativeManifestDigest = validateImageIndex(index, image, platform);
}
const predicate = {
  buildDefinition: {
    buildType: sourceRepository + '/container-build/v1',
    externalParameters: { sourceCommit: source, repository: sourceRepository, platform, image, nativeManifestDigest },
    internalParameters: { workflow: process.env.GITHUB_WORKFLOW_REF, imageIndex: index.toString('base64') },
    resolvedDependencies: baseMaterials(lock, platform)
  },
  runDetails: { builder: { id: signer }, metadata: {
    invocationId: `${sourceRepository}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`,
    toolVersions: { node: process.version, docker: version('docker', ['--version']),
      buildx: version('docker', ['buildx', 'version']), cosign: JSON.parse(version('cosign', ['version', '--json'])).gitVersion }
  }}
};
validateProvenance({ _type: 'https://in-toto.io/Statement/v0.1', predicateType,
  subject: [{ name: repository, digest: { sha256: image?.split('@sha256:')[1] } }], predicate }, image, source, lock);
writeFileSync('release-provenance.json', JSON.stringify(predicate, null, 2) + '\n');
console.log('Prepared ' + predicateType + ' predicate for immutable subject.');
