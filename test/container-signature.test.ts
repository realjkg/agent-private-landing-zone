import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { baseMaterials, validateProvenance, validateSbom, verifyImage, signer, issuer,
  predicateType, sbomType, workflow, repository, sourceRepository } from '../scripts/container-signature.mjs';
import { validateCommand } from '../scripts/container-run.mjs';

const lock = JSON.parse(readFileSync('config/container-bases.json', 'utf8'));
const indexBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json',
  manifests: [{ platform: { os: 'linux', architecture: 'arm64' }, digest: 'sha256:' + 'a'.repeat(64) }] }));
const imageDigest = createHash('sha256').update(indexBytes).digest('hex');
const image = repository + '@sha256:' + imageDigest;
const source = 'b'.repeat(40);
const subject = () => [{ name: repository, digest: { sha256: imageDigest } }];
const provenance = () => ({
  _type: 'https://in-toto.io/Statement/v0.1', predicateType, subject: subject(),
  predicate: {
    runDetails: { builder: { id: signer }, metadata: {
      invocationId: sourceRepository + '/actions/runs/123/attempts/1',
      toolVersions: { node: 'v26.9.0', docker: 'Docker version 28', buildx: 'buildx v0.29', cosign: 'v3.0.2' }
    } },
    buildDefinition: {
      buildType: sourceRepository + '/container-build/v1',
      externalParameters: { sourceCommit: source, repository: sourceRepository, image, platform: 'linux/arm64', nativeManifestDigest: 'sha256:' + 'a'.repeat(64) },
      internalParameters: { workflow, imageIndex: indexBytes.toString('base64') },
      resolvedDependencies: baseMaterials(lock, 'linux/arm64')
    }
  }
});
const sbom = () => ({ _type: 'https://in-toto.io/Statement/v0.1', predicateType: sbomType, subject: subject(),
  predicate: { bomFormat: 'CycloneDX', specVersion: '1.6', components: [{ type: 'library', name: 'zod', version: '4.6.5' }] }
});
const envelope = (value: unknown) => JSON.stringify({ payloadType: 'application/vnd.in-toto+json',
  payload: Buffer.from(JSON.stringify(value)).toString('base64') });

test('provenance binds exact image, source, platform, invocation, tools and base child identities', () => {
  assert.equal(validateProvenance(provenance(), image, source, lock), 'linux/arm64');
  validateSbom(sbom(), image);
});
for (const [name, mutate] of [
  ['wrong subject name', s => { s.subject[0].name = 'attacker/image'; }],
  ['altered subject', s => { s.subject[0].digest.sha256 = 'c'.repeat(64); }],
  ['extra subject', s => { s.subject.push(s.subject[0]); }],
  ['wrong predicate type', s => { s.predicateType = 'untrusted'; }],
  ['stale source', s => { s.predicate.buildDefinition.externalParameters.sourceCommit = 'd'.repeat(40); }],
  ['untrusted builder', s => { s.predicate.runDetails.builder.id = 'attacker'; }],
  ['wrong image parameter', s => { s.predicate.buildDefinition.externalParameters.image = 'other'; }],
  ['altered index bytes', s => { s.predicate.buildDefinition.internalParameters.imageIndex = Buffer.from('{}').toString('base64'); }],
  ['wrong native image', s => { s.predicate.buildDefinition.externalParameters.nativeManifestDigest = 'sha256:' + 'c'.repeat(64); }],
  ['unsupported platform', s => { s.predicate.buildDefinition.externalParameters.platform = 'windows/arm64'; }],
  ['wrong workflow ref', s => { s.predicate.buildDefinition.internalParameters.workflow = workflow.replace('main', 'other'); }],
  ['wrong source repository', s => { s.predicate.buildDefinition.externalParameters.repository = 'other'; }],
  ['unbound invocation', s => { s.predicate.runDetails.metadata.invocationId = 'https://example.com/123'; }],
  ['missing tool identity', s => { delete s.predicate.runDetails.metadata.toolVersions; }],
  ['unpinned signer tool', s => { s.predicate.runDetails.metadata.toolVersions.cosign = 'v1.0.0'; }],
  ['missing base materials', s => { s.predicate.buildDefinition.resolvedDependencies = []; }],
  ['wrong child digest', s => { s.predicate.buildDefinition.resolvedDependencies[1].digest.sha256 = 'e'.repeat(64); }],
  ['architecture mismatch', s => { s.predicate.buildDefinition.resolvedDependencies = baseMaterials(lock, 'linux/amd64'); }],
] as const satisfies ReadonlyArray<readonly [string, (s: any) => void]>) {
  test(`provenance rejects ${name}`, () => {
    const value = provenance(); mutate(value);
    assert.throws(() => validateProvenance(value, image, source, lock));
  });
}
for (const [name, mutate] of [
  ['wrong subject', s => { s.subject[0].digest.sha256 = 'f'.repeat(64); }],
  ['wrong repository', s => { s.subject[0].name = 'attacker'; }],
  ['wrong predicate', s => { s.predicateType = predicateType; }],
  ['non-CycloneDX data', s => { s.predicate.bomFormat = 'SPDX'; }],
  ['empty inventory', s => { s.predicate.components = []; }],
  ['missing component versions', s => { delete s.predicate.components[0].version; }],
] as const satisfies ReadonlyArray<readonly [string, (s: any) => void]>) {
  test(`SBOM rejects ${name}`, () => {
    const value = sbom(); mutate(value);
    assert.throws(() => validateSbom(value, image));
  });
}
test('verification requires successful cosign authentication with exact issuer and signer on every statement', () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    assert.equal(args[args.indexOf('--certificate-identity') + 1], signer);
    assert.equal(args[args.indexOf('--certificate-oidc-issuer') + 1], issuer);
    assert.equal(args.at(-1), image);
    return args[0] === 'verify' ? '{}' : envelope(args.includes('cyclonedx') ? sbom() : provenance());
  };
  const result = verifyImage(image, source, lock, run);
  assert.equal(calls.length, 3);
  assert.equal(result.platform, 'linux/arm64');
  assert.equal(result.productionReleaseApproved, false);
  for (const failure of ['unsigned', 'wrong signer', 'wrong issuer']) {
    assert.throws(() => verifyImage(image, source, lock, () => { throw new Error(failure); }));
  }
});
test('authenticated envelopes with stale provenance or invalid SBOM cannot satisfy verification', () => {
  const bad = provenance(); bad.predicate.buildDefinition.externalParameters.sourceCommit = 'f'.repeat(40);
  assert.throws(() => verifyImage(image, source, lock, args => args[0] === 'verify' ? '{}' : envelope(bad)), /PROVENANCE_MISSING/);
  const wrongSbom = sbom(); wrongSbom.subject[0].name = 'other';
  assert.throws(() => verifyImage(image, source, lock, args => args[0] === 'verify' ? '{}' :
    envelope(args.includes('cyclonedx') ? wrongSbom : provenance())), /SBOM_MISSING/);
});
test('mutable image arguments are rejected before invoking a signing tool', () => {
  for (const ref of [repository + ':latest', 'other@sha256:' + 'a'.repeat(64), image + ' --flag']) {
    assert.throws(() => verifyImage(ref, source, lock, () => assert.fail('must not execute')), /ARGUMENT_INVALID/);
  }
});
test('production wrapper accepts bounded offline commands and denies apply, installs, network and extra arguments', () => {
  assert.deepEqual(validateCommand([]), ['help']);
  for (const name of ['help', '--help', '-h', 'plugins', 'sbom', 'prompts', 'prompt-guide'])
    assert.deepEqual(validateCommand([name]), [name]);
  for (const args of [['apply'], ['apply', 'status'], ['deps'], ['inspect'], ['session'], ['workspace'],
    ['health', '--serve'], ['help', 'apply'], ['plugins', '--root', '/other'], ['--eval', 'process.exit()']])
    assert.throws(() => validateCommand(args), /CONFINED_COMMAND_DENIED/);
});
