import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASELINE_CONTROL_IDS,
  COMPLIANCE_PACK_DISCLAIMER,
  COMPLIANCE_PACK_IDS,
  CONTROL_STATUSES,
  EVIDENCE_MECHANISMS,
  LOCAL_MECHANISM_IDS,
  parseCompliancePack,
} from "../src/compliance/schema.js";
import {
  COMPLIANCE_PACKS,
  getCompliancePack,
} from "../src/compliance/packs/index.js";

const REPO_ROOT = fileURLToPath(
  new URL("..", import.meta.url),
);

const COMPLIANCE_DIR = join(
  REPO_ROOT,
  "src/compliance",
);

const EXPECTED_PACK_CATALOG: ReadonlyArray<
  readonly [string, number]
> = [
  ["HIPAA", 1],
  ["PCI_DSS", 4],
  ["SOC2_TYPE2", 1],
  ["ISO27001", 2022],
  ["AIUC1", 1],
];

function packWithRequirement(
  requirement: unknown,
): unknown {
  return {
    id: "HIPAA",
    version: 1,
    requirements: [requirement],
    disclaimer: COMPLIANCE_PACK_DISCLAIMER,
  };
}

function parseBaselineControlIds(
  baseline: string,
): string[] {
  const lines = baseline.split("\n");
  const start = lines.indexOf("lockedControls:");

  assert.ok(
    start >= 0,
    "config/security-baseline.md front matter must declare lockedControls",
  );

  const ids: string[] = [];

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (line === "---" || !/^\s+-\s+\S+$/.test(line)) {
      break;
    }

    ids.push(line.replace(/^\s+-\s+/, "").trim());
  }

  return ids;
}

test("all five packs validate under the zod schema and match the planned catalog", () => {
  assert.equal(COMPLIANCE_PACKS.length, 5);

  assert.deepEqual(
    COMPLIANCE_PACKS.map(
      (pack) => [pack.id, pack.version] as const,
    ),
    EXPECTED_PACK_CATALOG,
  );

  for (const pack of COMPLIANCE_PACKS) {
    assert.deepEqual(
      parseCompliancePack(pack),
      pack,
    );
  }
});

test("every pack id is a known pack id", () => {
  for (const pack of COMPLIANCE_PACKS) {
    assert.ok(
      (COMPLIANCE_PACK_IDS as readonly string[]).includes(
        pack.id,
      ),
    );
  }
});

test("every ALIGNED or GAP requirement references at least one local mechanism id", () => {
  for (const pack of COMPLIANCE_PACKS) {
    for (const requirement of pack.requirements) {
      if (requirement.status === "UNKNOWN") {
        continue;
      }

      assert.ok(
        requirement.mechanismIds.length >= 1,
        `${pack.id}@${pack.version} ${requirement.requirementId}: ${requirement.status} must reference a mechanism`,
      );

      for (const mechanismId of requirement.mechanismIds) {
        assert.ok(
          (LOCAL_MECHANISM_IDS as readonly string[]).includes(
            mechanismId,
          ),
          `${requirement.requirementId}: unknown mechanism id ${mechanismId}`,
        );
      }
    }
  }
});

test("mechanism vocabulary partitions into locked baseline controls and named evidence mechanisms", () => {
  const evidenceIds = Object.keys(
    EVIDENCE_MECHANISMS,
  );

  const controlIds = (LOCAL_MECHANISM_IDS as readonly string[])
    .filter((id) => !evidenceIds.includes(id));

  assert.deepEqual(
    [...controlIds],
    [...BASELINE_CONTROL_IDS],
  );

  assert.deepEqual(
    [...evidenceIds].sort(),
    (LOCAL_MECHANISM_IDS as readonly string[])
      .filter((id) => (BASELINE_CONTROL_IDS as readonly string[]).includes(id) === false)
      .sort(),
  );

  assert.equal(
    new Set(LOCAL_MECHANISM_IDS).size,
    LOCAL_MECHANISM_IDS.length,
    "LOCAL_MECHANISM_IDS must not contain duplicates",
  );
});

test("locked baseline controls stay in lockstep with config/security-baseline.md", async () => {
  const baseline = await readFile(
    resolve(REPO_ROOT, "config/security-baseline.md"),
    "utf8",
  );

  assert.deepEqual(
    BASELINE_CONTROL_IDS,
    parseBaselineControlIds(baseline),
  );
});

test("every named evidence mechanism grounds to an existing repository file", () => {
  for (const [id, mechanism] of Object.entries(
    EVIDENCE_MECHANISMS,
  )) {
    assert.ok(
      mechanism.description.length >= 1,
      `${id} must describe the mechanism it names`,
    );

    assert.ok(
      existsSync(resolve(REPO_ROOT, mechanism.source)),
      `${id} cites ${mechanism.source}, which does not exist`,
    );
  }
});

test("every cited evidencePath exists in the repository", () => {
  for (const pack of COMPLIANCE_PACKS) {
    for (const requirement of pack.requirements) {
      if (requirement.evidencePath === undefined) {
        continue;
      }

      assert.ok(
        existsSync(resolve(REPO_ROOT, requirement.evidencePath)),
        `${requirement.requirementId} cites ${requirement.evidencePath}, which does not exist`,
      );
    }
  }
});

test("UNKNOWN requirements stay honest and every pack uses the full status vocabulary", () => {
  assert.deepEqual(
    [...CONTROL_STATUSES],
    ["ALIGNED", "GAP", "UNKNOWN"],
  );

  for (const pack of COMPLIANCE_PACKS) {
    const statuses = new Set(
      pack.requirements.map(
        (requirement) => requirement.status,
      ),
    );

    assert.ok(
      statuses.has("ALIGNED"),
      `${pack.id}@${pack.version} must map at least one requirement as ALIGNED`,
    );

    assert.ok(
      statuses.has("UNKNOWN"),
      `${pack.id}@${pack.version} must admit at least one UNKNOWN requirement`,
    );

    for (const requirement of pack.requirements) {
      if (requirement.status !== "UNKNOWN") {
        continue;
      }

      assert.equal(
        requirement.status,
        "UNKNOWN",
        `${requirement.requirementId} must not be relabeled`,
      );
    }
  }
});

test("every pack carries the mapping-not-certification disclaimer", () => {
  for (const pack of COMPLIANCE_PACKS) {
    assert.ok(
      pack.disclaimer.includes("does not establish compliance"),
      `${pack.id}@${pack.version} disclaimer must state that selecting the pack does not establish compliance`,
    );
  }
});

test("requirement ids are unique across all packs", () => {
  const ids = COMPLIANCE_PACKS.flatMap(
    (pack) => pack.requirements.map(
      (requirement) => requirement.requirementId,
    ),
  );

  assert.equal(
    new Set(ids).size,
    ids.length,
    "requirementId must be globally unique so UI rows can key on it",
  );
});

test("the schema rejects packs that imply certification or skip mechanism joins", () => {
  assert.throws(() => {
    parseCompliancePack(
      packWithRequirement({
        requirementId: "X-1",
        title: "Certified control",
        status: "COMPLIANT",
        mechanismIds: [],
      }),
    );
  }, /invalid_enum_value|Invalid option/iu);

  assert.throws(() => {
    parseCompliancePack(
      packWithRequirement({
        requirementId: "X-1",
        title: "Aligned without a mechanism",
        status: "ALIGNED",
        mechanismIds: [],
      }),
    );
  }, /at least one local mechanism/iu);

  assert.throws(() => {
    parseCompliancePack({
      id: "ISO9001",
      version: 1,
      requirements: [
        {
          requirementId: "X-1",
          title: "Unknown framework",
          status: "UNKNOWN",
          mechanismIds: [],
        },
      ],
      disclaimer: COMPLIANCE_PACK_DISCLAIMER,
    });
  }, /invalid_enum_value|Invalid option/iu);

  assert.throws(() => {
    parseCompliancePack({
      id: "HIPAA",
      version: 1,
      requirements: [
        {
          requirementId: "X-1",
          title: "First",
          status: "UNKNOWN",
          mechanismIds: [],
        },
        {
          requirementId: "X-1",
          title: "Duplicate id",
          status: "UNKNOWN",
          mechanismIds: [],
        },
      ],
      disclaimer: COMPLIANCE_PACK_DISCLAIMER,
    });
  }, /unique/iu);

  assert.throws(() => {
    parseCompliancePack({
      id: "HIPAA",
      version: 1,
      requirements: [
        {
          requirementId: "X-1",
          title: "Stray authority field",
          status: "UNKNOWN",
          mechanismIds: [],
          grantsCapability: true,
        },
      ],
      disclaimer: COMPLIANCE_PACK_DISCLAIMER,
    });
  }, /unrecognized_keys|not expected/iu);
});

test("pack lookup finds an exact id and version only", () => {
  const found = getCompliancePack("HIPAA", 1);

  assert.ok(found !== undefined);
  assert.equal(found.id, "HIPAA");
  assert.equal(found.version, 1);

  assert.equal(
    getCompliancePack("HIPAA", 2),
    undefined,
    "a stale version must not resolve",
  );

  assert.equal(
    getCompliancePack("ISO9001", 1),
    undefined,
    "an unknown framework must not resolve",
  );
});

test("the compliance module imports nothing outside itself except zod", () => {
  const files = readdirSync(COMPLIANCE_DIR, {
    recursive: true,
  }).filter(
    (entry) => entry.endsWith(".ts"),
  );

  assert.ok(
    files.length >= 7,
    `expected the schema, five packs, and the barrel under ${COMPLIANCE_DIR}`,
  );

  for (const file of files) {
    const filePath = join(COMPLIANCE_DIR, file);
    const source = readFileSync(filePath, "utf8");

    const specifiers = [
      ...source.matchAll(
        /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*)["']([^"']+)["']/gu,
      ),
    ].map((match) => match[1]);

    for (const specifier of specifiers) {
      if (specifier === "zod") {
        continue;
      }

      assert.ok(
        specifier.startsWith("."),
        `${file}: unexpected non-relative import "${specifier}"`,
      );

      const resolvedWithoutSuffix = specifier
        .replace(/\.js$/u, ".ts");

      assert.ok(
        resolve(dirname(filePath), resolvedWithoutSuffix)
          .startsWith(COMPLIANCE_DIR),
        `${file}: import "${specifier}" escapes src/compliance`,
      );
    }
  }
});
