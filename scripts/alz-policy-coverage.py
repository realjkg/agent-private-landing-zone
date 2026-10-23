#!/usr/bin/env python3
"""Evaluate evidence coverage, not effective authorization, across OPA/SCP/RCP."""
import argparse
import json
from pathlib import Path

SURFACES=("opa","scp","rcp")
def coverage(data):
    governance=data.get("governance",data)
    results={}
    for kind in SURFACES:
        item=governance.get(kind)
        if item is None:
            results[kind]={"discovery":"UNKNOWN","effectiveness":"NOT_EVALUATED"}
        elif isinstance(item,dict):
            status=item.get("status","IMPORTED_UNVERIFIED")
            results[kind]={"discovery":status,"effectiveness":"NOT_EVALUATED",
                           "policyCount":len(item.get("policies",[])) if isinstance(item.get("policies"),list) else None}
        elif isinstance(item,list):
            results[kind]={"discovery":"IMPORTED_UNVERIFIED","effectiveness":"NOT_EVALUATED","policyCount":len(item)}
        else:
            raise ValueError("Malformed policy evidence: "+kind)
    return {"kind":"ALZ_GOVERNANCE_COVERAGE","schemaVersion":1,"mode":"PLAN_ONLY",
            "infrastructureAct":"DISABLED","surfaces":results,
            "greenfieldProposal":[{"surface":k,"status":"REQUIRES_HUMAN_MAPPING" if results[k]["discovery"]!="UNKNOWN" else "BLOCKED_MISSING_EVIDENCE"} for k in SURFACES],
            "warnings":["SCP, RCP and OPA are different enforcement planes; no equivalence inferred.",
                        "Attached policy documents do not prove effective authorization.",
                        "Missing evidence is not compliant status."],
            "enforcementValidated":False}
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input",required=True)
    parser.add_argument("--output",required=True)
    args=parser.parse_args()
    result=coverage(json.loads(Path(args.input).read_text()))
    path=Path(args.output)
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(result,indent=2)+"\n")
    print("Read-only governance coverage written:",path,"| enforcement NOT EVALUATED")
if __name__=="__main__":main()
