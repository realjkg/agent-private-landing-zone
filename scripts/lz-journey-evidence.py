#!/usr/bin/env python3
"""Offline evidence reconciliation; never invokes AWS, models or IaC."""
import argparse,hashlib,html,json,re
from pathlib import Path
STAGES=("instruction","private_models","discovery","inventory","governance","iac_preview","act_snapshot","independent_verification")
def assess(m,root):
    sha=m.get("source_sha"); engine=m.get("engine"); errors=[]
    if not isinstance(sha,str) or not re.fullmatch("[0-9a-f]{40}",sha): errors.append("INVALID_SOURCE")
    if engine not in ("TERRAFORM","CDK"): errors.append("INVALID_ENGINE")
    if m.get("mode")!="PREVIEW_OPERATE" or m.get("act_enabled") is not False: errors.append("ACT_DISABLED_REQUIRED")
    items=[]
    for stage in STAGES:
        e=m.get("stages",{}).get(stage,{})
        status="BLOCKED"; reason="MISSING_OR_UNVERIFIED"
        try:
            path=e["path"]; expected=e["sha256"]
            p=(root/path).resolve(strict=True)
            if not p.is_relative_to(root.resolve()) or not p.is_file() or p.stat().st_size>2000000: raise ValueError("UNSAFE_FILE")
            if e.get("source_sha")!=sha or e.get("engine") not in (engine,"SHARED"): raise ValueError("BINDING_MISMATCH")
            if e.get("authentic") is not True or not e.get("verified_by"): raise ValueError("AUTHENTICITY_NOT_ATTESTED")
            actual=hashlib.sha256(p.read_bytes()).hexdigest()
            if actual!=expected: raise ValueError("HASH_MISMATCH")
            status="REVIEW_REQUIRED";reason="HASH_MATCHES_NOT_PROVIDER_PROOF"
        except (KeyError,TypeError,OSError,ValueError) as exc: reason=str(exc) or reason
        items.append({"stage":stage,"status":status,"detail":reason})
    complete=not errors and all(x["status"]=="REVIEW_REQUIRED" for x in items)
    return {"schema":1,"source_sha":sha,"engine":engine,"stages":items,"structural_evidence_complete":complete,"errors":errors,"act_enabled":False,"release_admission":"HOLD","production_authorization":"NOT_GRANTED","review":"INDEPENDENT_REVIEW_REQUIRED" if complete else "BLOCKED"}
def render(report):
    rows="".join("<tr><td>%s</td><td>%s</td><td>%s</td></tr>"%tuple(html.escape(str(x[k])) for k in ("stage","status","detail")) for x in report["stages"])
    return '<!doctype html><html lang="en"><meta charset="utf-8"><title>LZ evidence</title><h1>LZ evidence journey</h1><p>ACT DISABLED — RELEASE HOLD — NOT AUTHORIZED</p><table border="1"><tr><th>Stage</th><th>Status</th><th>Detail</th></tr>'+rows+'</table><p>Independent provider and model review required.</p></html>'
def main():
    p=argparse.ArgumentParser();p.add_argument("--manifest",type=Path,required=True);p.add_argument("--output",type=Path,required=True);p.add_argument("--html",type=Path);a=p.parse_args()
    m=json.loads(a.manifest.read_text());r=assess(m,a.manifest.parent.resolve())
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(r,indent=2)+"\n")
    if a.html:a.html.parent.mkdir(parents=True,exist_ok=True);a.html.write_text(render(r))
    print(r["review"],"ACT DISABLED / RELEASE HOLD")
    return 0 if r["structural_evidence_complete"] else 2
if __name__=="__main__":raise SystemExit(main())
