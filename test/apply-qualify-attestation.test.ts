import assert from "node:assert/strict";
import test from "node:test";

import { engineSpec, type EngineSpec } from "../src/apply/engine-spec.js";
import { AWS } from "../src/apply/providers/aws.js";
import { AZURE } from "../src/apply/providers/azure.js";
import { GCP } from "../src/apply/providers/gcp.js";
import type { ProviderSpec } from "../src/apply/provider.js";

// SYNTHETIC. The text `./alz apply qualify` shows before the person types `SEPARATED <first> <second>` (#365 review 6510401916,
// N14). Each engine's prompt must ask only for what that engine's qualification run can show in the cloud's logs. No engine runs,
// and no cloud is reached; the typed phrase, the evidence and every gate are covered by the engine and CLI tests.

const FIRST = "first-principal-0001";
const SECOND = "second-principal-0002";

const spec = (id: string): EngineSpec => {
  const found = engineSpec(id);
  assert.ok(found, id);
  return found;
};
const shown = (id: string, provider: ProviderSpec): string => spec(id).notices.attestation(provider, FIRST, SECOND).join("\n");

for (const provider of [AWS, AZURE, GCP]) {
  test(`Terraform on ${provider.id}: the attestation names the state identities qualify uses and does not ask for APPLY's provider access`, () => {
    const terraform = spec("TERRAFORM");
    assert.deepEqual(terraform.attests, ["STATE_WRITE", "APPLY"], "the typed phrase still names STATE_WRITE, then APPLY");
    const text = shown("TERRAFORM", provider);
    assert.ok(text.includes(FIRST) && text.includes(SECOND), "both principals are named");
    assert.match(text, /state reads and writes\s+only by STATE_WRITE\s+first-principal-0001\s+or STATE/);
    assert.match(text, /no state access by\s+APPLY\s+second-principal-0002\s+and none by DISCOVERY/);
    assert.match(text, /it runs no step as APPLY\. It is checked at the first supervised DEV apply/);
    assert.match(text, /object \(data\) access for this run; if they do not, nothing here can be attested/);
    // The old prompt asked for these, which a qualification run cannot show.
    assert.doesNotMatch(text, /provider \(resource\) access is by/);
    assert.doesNotMatch(text, /access (is|was) by\s+APPLY/);
    assert.doesNotMatch(text, /leaves these backend settings to the apply process/);
    for (const setting of provider.filledAtApply) assert.ok(text.includes(setting), setting);
  });
}

test("Terraform's qualify notice lists every identity the run uses, and none as APPLY", () => {
  const reads = spec("TERRAFORM").notices.qualifyReads;
  assert.match(reads, /init and workspace as STATE, the throwaway plan as DISCOVERY, then init and workspace as STATE_WRITE and the state serial as STATE; nothing as APPLY/);
});

test("CDK: the attestation asks for describe-stacks reads only, never for a change set creation or execution in this run", () => {
  assert.deepEqual(spec("CDK").attests, ["CHANGESET", "APPLY"]);
  const text = shown("CDK", AWS);
  assert.match(text, /describe-stacks only, as DISCOVERY, CHANGESET\s+first-principal-0001\s+and APPLY\s+second-principal-0002/);
  assert.match(text, /no change set\s+was created or executed by any role in this run/);
  assert.match(text, /first observable at the seal and the first supervised DEV apply/);
  assert.doesNotMatch(text, /change set creation was by/);
  assert.doesNotMatch(text, /stack execution is by/);
});

test("Bicep: the attestation names the reads each identity made, and no what-if, create or delete", () => {
  assert.deepEqual(spec("BICEP").attests, ["DISCOVERY", "APPLY"]);
  const text = shown("BICEP", AZURE);
  assert.match(text, /DISCOVERY\s+first-principal-0001\s+read the group and the stack, APPLY\s+second-principal-0002\s+read the stack/);
  assert.match(text, /no what-if, stack create or delete ran in this run/);
  assert.match(text, /no write by either in this run/);
  assert.doesNotMatch(text, /reads were by/);
  assert.match(spec("BICEP").notices.qualifyReads, /az group show as DISCOVERY, and az stack group show as DISCOVERY and APPLY/);
});

test("GCP API: the attestation says APPLY only signed in, and no topic was created or deleted", () => {
  assert.deepEqual(spec("GCP_API").attests, ["DISCOVERY", "APPLY"]);
  const text = shown("GCP_API", GCP);
  assert.match(text, /DISCOVERY\s+first-principal-0001\s+signed in and ran one Cloud Asset search; APPLY\s+second-principal-0002\s+only signed in, with no Pub\/Sub call/);
  assert.match(text, /no topic\s+was created or deleted in this run/);
  assert.doesNotMatch(text, /topic create and delete\s+APPLY/);
});

test("every engine's attestation ends by asking for the typed phrase, and none claims a mutation happened during qualify", () => {
  for (const [id, provider] of [["TERRAFORM", AWS], ["CDK", AWS], ["BICEP", AZURE], ["GCP_API", GCP]] as const) {
    const lines = spec(id).notices.attestation(provider, FIRST, SECOND);
    assert.match(lines[lines.length - 1]!, /^Only if .*type \(anything else writes nothing\):$/, id);
    assert.doesNotMatch(lines.join("\n"), /\b(was|is) by\s+APPLY\b/, id);
  }
});
