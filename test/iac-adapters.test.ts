import assert from "node:assert/strict";
import test from "node:test";

import {
  PLUGIN_CATALOG,
} from "../src/plugins/catalog.js";
import {
  getIaCAdapter,
  hasIaCAdapter,
} from "../src/iac/index.js";

test("runtime adapters match catalog status", () => {
  for (const plugin of PLUGIN_CATALOG) {
    if (!plugin.stage.includes("BUILD")) {
      continue;
    }

    const expected =
      plugin.status === "IMPLEMENTED";

    assert.equal(
      hasIaCAdapter(plugin.id),
      expected,
      plugin.id +
        " adapter availability must match the plug-in catalog",
    );

    if (expected) {
      assert.equal(
        getIaCAdapter(plugin.id).engine,
        plugin.id,
      );
    } else {
      assert.throws(
        () => getIaCAdapter(plugin.id),
        /IAC_ADAPTER_NOT_IMPLEMENTED/,
      );
    }
  }
});
