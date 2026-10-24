#!/usr/bin/env python3
"""Bounded live operator evidence collection. No ACT or IaC execution."""
import argparse,hashlib,json,os,re,subprocess,sys
from datetime import datetime,timezone
from pathlib import Path

def collect(repo,out,sha,engine,run=subprocess.run):
    if not re.fullmatch(r"[0-9a-f]{40}",sha):raise ValueError("INVALID_SOURCE_SHA")
    if engine not in ("TERRAFORM","CDK"):raise ValueError("INVALID_ENGINE")
    if out.resolve().is_relative_to(repo.resolve()):raise ValueError("EVIDENCE_DIRECTORY_MUST_BE_OUTSIDE_REPO")
    out.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.chmod(out,0o700)
    manifest={"source_sha":sha,"engine":engine,"mode":"PREVIEW_OPERATE","act_enabled":False,"stages":{}}
    # Existing ALZ CLI is the authority boundary; never execute an operator-selected shell string.
    steps=[("private_models",["./alz","models","verify"]),("discovery",["./alz","discover","--provider","aws"])]
    for name,args in steps:
        try:
            result=run(args,cwd=repo,capture_output=True,text=True,timeout=180,check=False)
            code=result.returncode
            # CLI output may contain account inventory, errors or credentials. Never persist stdout/stderr.
            status="EXECUTED_REVIEW_REQUIRED" if code==0 else "BLOCKED"
            detail={"stage":name,"status":status,"exit_code":code,"source_sha":sha,
                    "command":args,"collected_utc":datetime.now(timezone.utc).isoformat(),
                    "raw_output_retained":False,"authenticity":"UNVERIFIED","act_enabled":False}
        except (OSError,subprocess.TimeoutExpired) as exc:
            detail={"stage":name,"status":"BLOCKED","reason":type(exc).__name__,"source_sha":sha,
                    "raw_output_retained":False,"authenticity":"UNVERIFIED","act_enabled":False}
        p=out/(name+".json");p.write_text(json.dumps(detail,indent=2)+"\n");os.chmod(p,0o600)
        manifest["stages"][name]={"path":p.name,"sha256":hashlib.sha256(p.read_bytes()).hexdigest(),
                                  "source_sha":sha,"engine":"SHARED","authentic":False,"verified_by":""}
    p=out/"manifest.json";p.write_text(json.dumps(manifest,indent=2)+"\n");os.chmod(p,0o600)
    return manifest
def main():
    p=argparse.ArgumentParser()
    p.add_argument("--repo",type=Path,required=True);p.add_argument("--output-dir",type=Path,required=True)
    p.add_argument("--source-sha",required=True);p.add_argument("--engine",choices=("TERRAFORM","CDK"),required=True)
    a=p.parse_args()
    collect(a.repo,a.output_dir,a.source_sha,a.engine)
    print("MODEL_AND_DISCOVERY_CHECKS_COLLECTED; PREVIEW_NOT_EXECUTED; ACT_DISABLED; RELEASE_HOLD")
if __name__=="__main__":main()
