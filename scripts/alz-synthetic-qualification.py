#!/usr/bin/env python3
"""One-command deterministic synthetic qualification of cost + governance evidence."""
import pathlib
import subprocess
import sys

ROOT=pathlib.Path(__file__).resolve().parents[1]
files=["alz-cost-acceptance.test.py","alz-evidence-integration.test.py"]
for filename in files:
    run=subprocess.run([sys.executable,str(ROOT/"test"/filename)],cwd=ROOT,check=False)
    if run.returncode:
        print("SYNTHETIC_QUALIFICATION_FAILED",filename)
        raise SystemExit(run.returncode)
print("SYNTHETIC_QUALIFICATION_PASSED: import, dashboard, policy coverage")
print("Live AWS, OPA authorization, billing reconciliation and Grafana runtime NOT TESTED")
