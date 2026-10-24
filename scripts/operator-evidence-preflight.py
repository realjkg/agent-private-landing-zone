#!/usr/bin/env python3
"""Read-only, standard-library ALZ operator readiness report."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

BASELINE = ("qwen3:1.7b", "qwen3:4b", "mistral-nemo:latest")

def command(argv, timeout=15):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
        return {"status": "PASS" if p.returncode == 0 else "FAIL", "exit_code": p.returncode,
                "stdout": p.stdout.strip()[:4000], "stderr": p.stderr.strip()[:1000]}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"status": "FAIL", "error": type(exc).__name__}

def installed_models():
    result = command(["ollama", "list"])
    if result["status"] != "PASS":
        return [], result
    tags = []
    for line in result["stdout"].splitlines()[1:]:
        fields = line.split()
        if fields:
            tags.append(fields[0])
    return tags, result

def evaluate(repo, provider, profile, region, candidates):
    checks = {}
    for name in ("python3", "node", "npm", "ollama", "terraform", "aws"):
        present = shutil.which(name) is not None
        needed = name in ("python3", "node", "npm", "ollama") or (provider == "aws" and name == "aws")
        checks[name] = {"status": "PASS" if present else ("FAIL" if needed else "SKIPPED"),
                        "required": needed, "path": shutil.which(name)}
    checks["repo"] = {"status": "PASS" if (repo / "alz").is_file() and (repo / "package.json").is_file() else "FAIL",
                      "required": True, "path": str(repo)}
    tags, discovery = installed_models() if checks["ollama"]["status"] == "PASS" else ([], {"status": "NOT_RUN"})
    checks["ollama_list"] = {"status": discovery["status"], "required": True}
    checks["baseline_models"] = {"status": "PASS" if all(m in tags for m in BASELINE) else "FAIL",
                                 "required": True, "missing": [m for m in BASELINE if m not in tags]}
    checks["candidate_models"] = {"status": "PASS" if candidates and all(m in tags for m in candidates) else "NOT_RUN",
                                  "required": False, "selected": candidates,
                                  "missing": [m for m in candidates if m not in tags]}
    checks["aws_identity"] = {"status": "SKIPPED", "required": provider == "aws"}
    if provider == "aws":
        if not profile or not region or checks["aws"]["status"] != "PASS":
            checks["aws_identity"] = {"status": "FAIL", "required": True,
                                      "reason": "AWS profile, region, and CLI are required"}
        else:
            env = dict(os.environ, AWS_PROFILE=profile, AWS_DEFAULT_REGION=region)
            try:
                p = subprocess.run(["aws", "sts", "get-caller-identity", "--output", "json"],
                                   capture_output=True, text=True, timeout=20, env=env, check=False)
                if p.returncode == 0:
                    identity = json.loads(p.stdout)
                    checks["aws_identity"] = {"status": "PASS", "required": True,
                                               "account": identity.get("Account"), "arn": identity.get("Arn")}
                else:
                    checks["aws_identity"] = {"status": "FAIL", "required": True,
                                               "reason": "AWS authentication or authorization failed"}
            except (OSError, ValueError, subprocess.TimeoutExpired):
                checks["aws_identity"] = {"status": "FAIL", "required": True,
                                           "reason": "AWS identity could not be verified"}
    blocked = any(v["status"] != "PASS" for v in checks.values() if v.get("required"))
    return {"schema_version": 1, "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "scope": "PREFLIGHT_ONLY", "provider": provider, "region": region if provider == "aws" else None,
            "checks": checks, "installed_model_tags": tags,
            "decision": "BLOCKED" if blocked else "READY_FOR_QUALIFICATION",
            "limitations": ["No inference performed", "No cloud inventory or IaC preview performed",
                            "No infrastructure mutation or model swap"]}

def main():
    ap = argparse.ArgumentParser(description="ALZ operator evidence preflight (read-only)")
    ap.add_argument("--repo", type=Path, default=Path.cwd())
    ap.add_argument("--provider", choices=["local", "aws"], default="local")
    ap.add_argument("--aws-profile")
    ap.add_argument("--aws-region")
    ap.add_argument("--candidate", action="append", default=[], help="Exact installed Ollama tag; repeatable")
    ap.add_argument("--output", type=Path, default=Path(".runs/operator-evidence/preflight.json"))
    args = ap.parse_args()
    report = evaluate(args.repo.resolve(), args.provider, args.aws_profile, args.aws_region, args.candidate)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(report, indent=2, sort_keys=True) + "\n"
    args.output.write_text(payload, encoding="utf-8")
    digest = hashlib.sha256(payload.encode()).hexdigest()
    print(f"Decision: {report['decision']} | Evidence: {args.output} | SHA256: {digest}")
    for key, value in report["checks"].items():
        print(f"  {value['status']:8} {key}")
    return 1 if report["decision"] == "BLOCKED" else 0

if __name__ == "__main__":
    sys.exit(main())
