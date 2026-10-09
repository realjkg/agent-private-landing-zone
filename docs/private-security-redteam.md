# Private ALZ injection and privilege-escalation qualification

## Scope and account isolation

This is a **defensive regression suite against local deterministic policy and broker code**. It does not sign in to, inspect, test, or send payloads to ChatGPT or any OpenAI API/account, and does not invoke external models or cloud providers. The attack inputs are inert strings or locally generated Ed25519 test leases. No real cloud credentials, remote endpoints, external shell command, infrastructure ACT, user data or live production identity are involved.

The test suite explicitly replaces `fetch` with a counter that throws on every attempted call and asserts zero calls. Its typed-broker probes use **only deliberately unsupported tool names** and verify rejection before a process is launched. Its action handlers are pure local counters; no external mutation implementation is installed.

## Executed adversarial classes

The 49-case corpus is deterministic and source-linked:

- 16 injected operator prompts: role spoofing, higher-priority overrides, Unicode/zero-width obfuscation, instruction leakage requests, tool coercion, and educational-clause laundering.
- 3 untrusted evidence/transcript/operator boundary spoof cases, asserting escape of reserved delimiters.
- 12 attempts to force forbidden broker tool names, including generic infrastructure apply/destroy/deploy, role changes, and arbitrary shell.
- 2 external egress/secret-protection denials.
- 14 externally signed lease/privilege tests: forged signature, unknown operation, expanded lease, expiry, target/hash substitution, hidden fields, compromised host spoofing VERIFIED, missing or denied local OPA.
- 2 benign educational control prompts expected allowed, to limit obvious false positives.

Host compromise state is now **runtime-trusted**, and request-side claims of VERIFIED are rejected if the private host is SUSPECTED/CONTAINED/RECOVERY. The built-in policy evaluates the trusted host state. The change requires the trusted host to populate `ActionRegistryDeps.trustedCompromiseState`; untrusted model prompts must never supply it.

Run from an exact, clean revision with already-installed dependencies:

```sh
npm ci
npm run build
node dist/cli/private-security-redteam.js
```

The command produces source-bound JSON/CSV reports under `.runs/qualification/private-security/`. The dedicated CI assertion suite is `test/private-security-redteam.test.ts`. The normal PR CI also checks existing policy, local-OPA, broker, model and governed-action tests.

## Evidence contract, interpretation and blockers

A per-case `PASS` means the specific expected denial, neutralization or benign allow was observed and matched the exact source/test input. Each row includes the SHA256 of its source-linked observation. `noOpenAiCalls=true` is an execution-mode contract, corroborated by the test's fetch spy; it does **not** prove a global host firewall or absence of all process/network interfaces. The suite never imports OpenAI libraries or accesses an account, and the test runner must be isolated with no external secrets.

**This cannot prove that ALL unknown prompts are blocked, that a real Qwen/Mistral model never follows malicious instructions, or that arbitrary provider handlers and a real lease issuer are safe.** Those remain separate checks: actual local model adversarial inference, local OPA runtime, real durable replay storage, and authorized target handler recovery. Record them `NOT_RUN`, not `PASS`, until their actual evidence exists. A red-team failure is a release blocker for the corresponding claim and must be fixed in the owning DO path; never loosen the expected result to make CI green.
