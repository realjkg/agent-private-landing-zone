// EMULATED. The out-of-process half of test/cost-baseline-emulated-aws.test.ts: a CONNECT proxy and one loopback HTTPS stub.
// It runs in its own process because the apply driver blocks the test process during its synchronous engine steps (the same
// reason test/apply-emulated-aws.test.ts keeps its proxy in a helper). Nothing here reaches the internet.
//
// Routing (every other host is refused with 403 and logged):
// - moto (a real AWS emulator) serves STS, S3 (state and the export bucket), S3 Control (bucket tags) and SNS;
// - this stub serves what moto 5.2 does not: AWS Budgets' DescribeSubscribersForNotification and resource tagging, and the
//   whole of AWS Data Exports (`bcm-data-exports`, absent from moto). It is an in-memory stand-in for those JSON APIs, written
//   for this test only. It proves that the product's driver, the aws provider and the plan flow work end to end; it says
//   nothing about how the real services behave;
// - the Terraform registry protocol (registry.terraform.io) and the release download (releases.hashicorp.com) are served from
//   files the operator downloaded: HashiCorp's real provider zip, SHA256SUMS, its signature and public key. Terraform itself
//   verifies the signature and the hashes, and the reviewed lock's h1 hash, so the provider that runs is HashiCorp's.
//
// Usage: node cost-emulator.cjs <motoPort> <keyPem> <certPem> <providerDir> <logFile>
// Required as a module (test/cost-project.test.ts), it starts nothing and exports the routing and the stub handlers, so the
// always-run test checks them in-process, with no certificate and no external tool.
"use strict";
const crypto = require("node:crypto"), fs = require("node:fs"), http = require("node:http"), https = require("node:https"), net = require("node:net"), path = require("node:path");
const MAIN = require.main === module;
const [motoPort, keyFile, certFile, providerDir, logFile] = MAIN ? process.argv.slice(2) : [];
const log = (line) => { if (logFile) fs.appendFileSync(logFile, line + "\n"); };

const PROVIDER = { version: "6.68.0", zip: "terraform-provider-aws_6.68.0_linux_amd64.zip", sums: "terraform-provider-aws_6.68.0_SHA256SUMS" };
const MOTO_HOSTS = [/^sts\.us-east-1\.amazonaws\.com$/, /^sns\.us-east-1\.amazonaws\.com$/, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.s3\.us-east-1\.amazonaws\.com$/,
  // In us-east-1 the provider addresses a bucket at the legacy global endpoint.
  /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.s3\.amazonaws\.com$/,
  /^[0-9]{12}\.s3-control\.us-east-1\.amazonaws\.com$/, /^tagging\.us-east-1\.amazonaws\.com$/];
const STUB_HOSTS = new Set(["budgets.amazonaws.com", "bcm-data-exports.us-east-1.api.aws", "registry.terraform.io", "releases.hashicorp.com"]);

// --- AWS Budgets and Data Exports, in memory ----------------------------------------------------------------------------
const budgets = new Map(), tags = new Map(), exportsByArn = new Map();
const json = (status, body) => ({ status, type: "application/x-amz-json-1.1", body: JSON.stringify(body) });
const notFound = (type, message) => json(400, { __type: type, Message: message });
const noteKey = (n) => JSON.stringify([n.NotificationType, n.ComparisonOperator, n.Threshold, n.ThresholdType || "PERCENTAGE"]);
const retag = (arn, add, remove = []) => {
  const kept = (tags.get(arn) || []).filter((t) => !remove.includes(t.Key) && !add.some((a) => a.Key === t.Key));
  tags.set(arn, [...kept, ...add]);
};

function budgetsOp(op, b) {
  const arnOf = (name) => "arn:aws:budgets::" + b.AccountId + ":budget/" + name;
  const found = () => budgets.get(b.AccountId + "/" + b.BudgetName);
  switch (op) {
    case "CreateBudget": {
      const id = b.AccountId + "/" + b.Budget.BudgetName;
      if (budgets.has(id)) return json(400, { __type: "DuplicateRecordException", Message: "the budget exists" });
      const notes = new Map();
      for (const ns of b.NotificationsWithSubscribers || []) notes.set(noteKey(ns.Notification), { n: ns.Notification, s: ns.Subscribers });
      const now = Math.floor(Date.now() / 1000);
      // No CalculatedSpend: a new budget has none until AWS first calculates it (the status reads that as WAITING).
      budgets.set(id, { budget: { ...b.Budget, TimePeriod: { Start: now - (now % 86400), End: (b.Budget.TimePeriod || {}).End || 3706473600 }, LastUpdatedTime: now }, notes });
      tags.set(arnOf(b.Budget.BudgetName), b.ResourceTags || []);
      return json(200, {});
    }
    case "DescribeBudget": { const x = found(); return x ? json(200, { Budget: x.budget }) : notFound("NotFoundException", "no budget"); }
    case "DescribeBudgets": return json(200, { Budgets: [...budgets.entries()].filter(([id]) => id.startsWith(b.AccountId + "/")).map(([, x]) => x.budget) });
    case "DeleteBudget": { if (!budgets.delete(b.AccountId + "/" + b.BudgetName)) return notFound("NotFoundException", "no budget"); tags.delete(arnOf(b.BudgetName)); return json(200, {}); }
    case "CreateNotification": { const x = found(); if (!x) return notFound("NotFoundException", "no budget"); x.notes.set(noteKey(b.Notification), { n: b.Notification, s: b.Subscribers }); return json(200, {}); }
    case "DeleteNotification": { const x = found(); if (!x) return notFound("NotFoundException", "no budget"); x.notes.delete(noteKey(b.Notification)); return json(200, {}); }
    case "DescribeNotificationsForBudget": {
      const x = found();
      return x ? json(200, { Notifications: [...x.notes.values()].map((v) => ({ ThresholdType: "PERCENTAGE", NotificationState: "OK", ...v.n })) }) : notFound("NotFoundException", "no budget");
    }
    case "DescribeSubscribersForNotification": { const v = found()?.notes.get(noteKey(b.Notification)); return v ? json(200, { Subscribers: v.s }) : notFound("NotFoundException", "no notification"); }
    case "ListTagsForResource": return tags.has(b.ResourceARN) ? json(200, { ResourceTags: tags.get(b.ResourceARN) }) : notFound("NotFoundException", "no resource");
    case "TagResource": retag(b.ResourceARN, b.ResourceTags); return json(200, {});
    case "UntagResource": retag(b.ResourceARN, [], b.ResourceTagKeys); return json(200, {});
  }
  return json(400, { __type: "InvalidRequestException", Message: "the test stub does not implement Budgets " + op });
}

function exportsOp(op, b) {
  const missing = () => notFound("ResourceNotFoundException", "no export");
  switch (op) {
    case "CreateExport": {
      const arn = "arn:aws:bcm-data-exports:us-east-1:" + ACCOUNT.current + ":export/" + b.Export.Name + "-" + crypto.randomUUID();
      const now = new Date().toISOString();
      exportsByArn.set(arn, { Export: { ...b.Export, ExportArn: arn }, ExportStatus: { StatusCode: "HEALTHY", CreatedAt: now, LastUpdatedAt: now } });
      tags.set(arn, b.ResourceTags || []);
      return json(200, { ExportArn: arn });
    }
    case "GetExport": { const x = exportsByArn.get(b.ExportArn); return x ? json(200, x) : missing(); }
    case "ListExports": return json(200, { Exports: [...exportsByArn.values()].map((x) => ({ ExportArn: x.Export.ExportArn, ExportName: x.Export.Name, ExportStatus: x.ExportStatus })) });
    case "DeleteExport": return exportsByArn.delete(b.ExportArn) ? json(200, { ExportArn: b.ExportArn }) : missing();
    // No delivery has run: the first CUR 2.0 delivery takes up to a day, which an emulator does not pretend to do.
    case "ListExecutions": return exportsByArn.has(b.ExportArn) ? json(200, { Executions: [] }) : missing();
    case "ListTagsForResource": return tags.has(b.ResourceArn) ? json(200, { ResourceTags: tags.get(b.ResourceArn) }) : missing();
    case "TagResource": retag(b.ResourceArn, b.ResourceTags); return json(200, {});
    case "UntagResource": retag(b.ResourceArn, [], b.ResourceTagKeys); return json(200, {});
  }
  return json(400, { __type: "ValidationException", Message: "the test stub does not implement Data Exports " + op });
}
// The account the export ARN names: the STS account of the signed request is not checked by this stub, so the test sets it.
const ACCOUNT = { current: "000000000000" };

// --- the registry protocol, from the operator's downloaded files ---------------------------------------------------------
function registry(host, url) {
  const file = (name) => ({ status: 200, type: "application/octet-stream", body: fs.readFileSync(path.join(providerDir, name)) });
  if (host === "releases.hashicorp.com") {
    const name = url.split("/").pop();
    if ([PROVIDER.zip, PROVIDER.sums, PROVIDER.sums + ".sig"].includes(name) && url === "/terraform-provider-aws/" + PROVIDER.version + "/" + name) return file(name);
    return { status: 404, type: "text/plain", body: "not served" };
  }
  if (url === "/.well-known/terraform.json") return { status: 200, type: "application/json", body: JSON.stringify({ "providers.v1": "/v1/providers/" }) };
  if (url === "/v1/providers/hashicorp/aws/versions") {
    return { status: 200, type: "application/json", body: JSON.stringify({ versions: [{ version: PROVIDER.version, protocols: ["5.0"], platforms: [{ os: "linux", arch: "amd64" }] }] }) };
  }
  if (url === "/v1/providers/hashicorp/aws/" + PROVIDER.version + "/download/linux/amd64") {
    const base = "https://releases.hashicorp.com/terraform-provider-aws/" + PROVIDER.version + "/";
    const sum = fs.readFileSync(path.join(providerDir, PROVIDER.sums), "utf8").split("\n").find((line) => line.endsWith("  " + PROVIDER.zip)).split("  ")[0];
    return { status: 200, type: "application/json", body: JSON.stringify({
      protocols: ["5.0"], os: "linux", arch: "amd64", filename: PROVIDER.zip, download_url: base + PROVIDER.zip,
      shasums_url: base + PROVIDER.sums, shasums_signature_url: base + PROVIDER.sums + ".sig", shasum: sum,
      signing_keys: { gpg_public_keys: [{ key_id: "34365D9472D7468F", ascii_armor: fs.readFileSync(path.join(providerDir, "hashicorp.asc"), "utf8"), trust_signature: "", source: "HashiCorp", source_url: "https://www.hashicorp.com/security.html" }] },
    }) };
  }
  return { status: 404, type: "text/plain", body: "not served" };
}

/** Where one CONNECT target goes: the stub, moto, or nowhere (null, refused). Only port 443 of a listed host is ever routed. */
function routeOf(target, stubPort, motoPortNumber) {
  const [host, port] = String(target).split(":");
  if (port !== "443") return null;
  if (STUB_HOSTS.has(host)) return stubPort;
  return MOTO_HOSTS.some((p) => p.test(host)) ? motoPortNumber : null;
}

module.exports = { routeOf, budgetsOp, exportsOp, registry, setAccount: (id) => { ACCOUNT.current = id; } };
if (MAIN) serve();

function serve() {
const stub = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const host = String(req.headers.host || "").split(":")[0];
    let out;
    try {
      if (req.url === "/__emulator/state" && host === "emulator.invalid") {
        out = { status: 200, type: "application/json", body: JSON.stringify({
          budgets: [...budgets.entries()].map(([id, x]) => ({ id, budget: x.budget, notifications: [...x.notes.values()] })),
          exports: [...exportsByArn.values()], tags: [...tags.entries()] }) };
      } else if (req.url.startsWith("/__emulator/account/") && host === "emulator.invalid") {
        ACCOUNT.current = req.url.split("/").pop();
        out = { status: 200, type: "text/plain", body: "ok" };
      } else if (host === "budgets.amazonaws.com" || host === "bcm-data-exports.us-east-1.api.aws") {
        const [prefix, op] = String(req.headers["x-amz-target"] || "").split(".");
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        out = prefix === "AWSBudgetServiceGateway" ? budgetsOp(op, body)
          : prefix === "AWSBillingAndCostManagementDataExports" ? exportsOp(op, body)
          : json(400, { __type: "UnknownOperationException" });
        log("STUB " + host + " " + prefix + "." + op + " " + out.status);
      } else {
        out = registry(host, req.url);
        log("STUB " + host + " " + req.url + " " + out.status);
      }
    } catch (error) {
      out = { status: 500, type: "text/plain", body: String(error && error.message) };
    }
    res.writeHead(out.status, { "content-type": out.type, "content-length": Buffer.byteLength(out.body) });
    res.end(out.body);
  });
});

stub.listen(0, "127.0.0.1", () => {
  const stubPort = stub.address().port;
  const proxy = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
  proxy.on("connect", (req, client, head) => {
    client.on("error", () => client.destroy());
    const upstreamPort = routeOf(req.url, stubPort, Number(motoPort));
    log("CONNECT " + req.url + (upstreamPort ? "" : " REFUSED"));
    if (!upstreamPort) { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const upstream = net.connect(upstreamPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
  proxy.on("clientError", (_error, socket) => socket.destroy());
  proxy.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ proxyPort: proxy.address().port, stubPort }) + "\n"));
});
}
