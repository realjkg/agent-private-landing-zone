import {
  assessSessionSecurity,
} from "../security/session.js";

const posture =
  await assessSessionSecurity();

console.log();
console.log("Agent Private Landing Zone");
console.log("────────────────────────────────");
console.log("SECURITY PREFLIGHT");
console.log();

for (const control of posture.controls) {
  console.log(
    (control.passed ? "✓ " : "! ") +
      control.name.padEnd(14) +
      control.detail,
  );
}

console.log();
console.log(
  posture.secured
    ? "SECURED SESSION READY"
    : "SECURE SESSION REFUSED",
);

if (!posture.secured) {
  process.exitCode = 1;
}
