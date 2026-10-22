#!/usr/bin/env python3
"""Read-only, offline ALZ evidence -> financial -> security -> greenfield plan."""
import argparse
import csv
import hashlib
import json
from pathlib import Path

SOURCES = {"rvtools", "focus", "assets", "opencost"}
POLICIES = ("opa", "scp", "rcp")
def load(path):
    if not path:
        return None
    p = Path(path)
    if p.suffix.lower() == ".json":
        return json.loads(p.read_text())
    if p.suffix.lower() == ".csv":
        with p.open(newline="") as stream:
            return list(csv.DictReader(stream))
    raise ValueError("Unsupported evidence format; supply JSON or CSV. RVTools XLSX requires an exported CSV.")
def source(path):
    if not path: return {"status":"MISSING","sha256":None}
    return {"status":"PRESENT","sha256":hashlib.sha256(Path(path).read_bytes()).hexdigest()}
def build(args):
    inventory=load(args.inventory)
    financial=load(args.financial)
    policy=load(args.policies)
    if inventory is not None and not isinstance(inventory,(dict,list)):
        raise ValueError("Inventory must be an object or rows")
    if financial is not None and not isinstance(financial,(dict,list)):
        raise ValueError("Financial evidence must be an object or rows")
    if policy is not None and not isinstance(policy,dict):
        raise ValueError("Policy evidence must be a JSON object")
    categories=("cloud","hardware","licensing","facilities")
    financial_categories={}
    for category in categories:
        values=financial.get(category) if isinstance(financial,dict) else None
        financial_categories[category]={"status":"PRESENT_UNVERIFIED" if values is not None else "UNKNOWN","data":values}
    surfaces={}
    for key in POLICIES:
        record=(policy or {}).get(key)
        surfaces[key]={"status":"DISCOVERED" if isinstance(record,(dict,list)) and bool(record) else "UNKNOWN",
                       "evidence":record if isinstance(record,(dict,list)) else None,
                       "enforcementPlane":{"opa":"POLICY_AS_CODE","scp":"AWS_PRINCIPAL_PERMISSIONS_GUARDRAIL","rcp":"AWS_RESOURCE_PERMISSIONS_GUARDRAIL"}[key]}
    return {
       "schemaVersion":1,"kind":"SOVEREIGN_ALZ_EVIDENCE_SEQUENCE","mode":"PLAN_ONLY",
       "infrastructureAct":"DISABLED","sourceFiles":{"inventory":source(args.inventory),"financial":source(args.financial),"policies":source(args.policies)},
       "discovery":{"status":"EVIDENCED" if inventory is not None else "UNKNOWN","inventory":inventory},
       "financial":{"status":"EVIDENCED" if financial is not None else "UNKNOWN","evidence":financial,
                    "actualCostVerified":False,"requiredCategories":financial_categories,"limitations":["Imported amounts require provenance, time period, currency and allocation verification before classifying actuals."]},
       "governance":{"brownfield":surfaces,"equivalenceClaimed":False},
       "greenfield":{"status":"PROPOSED","policyIntent":[{"source":name,"mappingStatus":"REQUIRES_HUMAN_REVIEW" if item["status"]=="DISCOVERED" else "UNKNOWN","enforcementPlane":item["enforcementPlane"]} for name,item in surfaces.items()],"applyAuthorized":False},
       "costObservability":{"dashboard":"grafana","metrics":"prometheus","telemetry":"opentelemetry","sources":sorted(SOURCES),
                            "liveInfrastructureTelemetry":True,"mode":"PLAN_ONLY","excluded":["DrMigrate","FinOps Ratio"]}
    }
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory",help="RVTools CSV or inventory JSON")
    parser.add_argument("--financial",help="FOCUS/asset CSV or financial JSON")
    parser.add_argument("--policies",help="policy evidence JSON with opa/scp/rcp keys")
    parser.add_argument("--output",help="Optional path for generated read-only report")
    args=parser.parse_args()
    report=build(args)
    text=json.dumps(report,indent=2,sort_keys=True)
    if args.output:
        Path(args.output).write_text(text+"\n")
    else:
        print(text)
if __name__=="__main__":
    main()
