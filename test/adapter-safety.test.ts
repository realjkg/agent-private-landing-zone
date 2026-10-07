import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";

import {
  ansibleAdapter,
} from "../src/iac/ansible.js";

test("Ansible preview refuses playbooks that disable check mode", () => {
  const cwd =
    mkdtempSync(
      join(
        tmpdir(),
        "alz-ansible-",
      ),
    );

  try {
    const playbook =
      join(cwd, "site.yml");

    writeFileSync(
      playbook,
      [
        "- hosts: all",
        "  tasks:",
        "    - name: unsafe preview override",
        "      ansible.builtin.command: /bin/true",
        "      check_mode: false",
      ].join("\n"),
    );

    const result =
      ansibleAdapter.preview(
        {
          cwd,
          allowCloudRead: false,
          allowProjectCodeExecution:
            true,
          allowManagedAccess: true,
          allowMutation: false,
        },
        {
          playbookPath: "site.yml",
        },
      );

    assert.equal(
      result.blocked,
      true,
    );
    assert.match(
      result.reason ?? "",
      /disables check mode/i,
    );
  } finally {
    rmSync(
      cwd,
      {
        recursive: true,
        force: true,
      },
    );
  }
});
