#!/usr/bin/env python3
"""Offline cost importer: FOCUS CSV and documented asset rate-card CSV -> Grafana-ready snapshots."""
import argparse
import csv
import datetime as dt
import hashlib
import json
import math
from decimal import Decimal, InvalidOperation
from pathlib import Path

CATEGORIES = ("cloud", "hardware", "licensing", "facilities")
def rows(path):
    with Path(path).open(encoding="utf-8-sig",newline="") as file:
        reader=csv.DictReader(file)
        if not reader.fieldnames:
            raise ValueError("Missing CSV header")
        return list(reader), set(reader.fieldnames)
def money(text):
    try:
        value=Decimal(str(text))
    except (InvalidOperation, TypeError):
        raise ValueError("Invalid monetary amount") from None
    if not value.is_finite():
        raise ValueError("Nonfinite monetary amount")
    return value
def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def required(columns, needed):
    absent=set(needed)-columns
    if absent: raise ValueError("Missing columns: "+", ".join(sorted(absent)))
def focus(path):
    items,columns=rows(path)
    required(columns,("BilledCost","BillingCurrency","ChargePeriodStart","ChargePeriodEnd"))
    output=[]
    for number,item in enumerate(items,2):
        if item["BillingCurrency"].strip()!="USD":
            raise ValueError(f"FOCUS row {number}: requires USD conversion evidence")
        start=item["ChargePeriodStart"].strip()
        end=item["ChargePeriodEnd"].strip()
        try:
            s=dt.datetime.fromisoformat(start.replace("Z","+00:00"))
            e=dt.datetime.fromisoformat(end.replace("Z","+00:00"))
        except ValueError:
            raise ValueError(f"FOCUS row {number}: invalid charge period") from None
        if e<=s: raise ValueError(f"FOCUS row {number}: invalid time range")
        output.append({"category":"cloud","source":"focus","amountUsd":str(money(item["BilledCost"])),
                       "periodStart":start,"periodEnd":end,
                       "resource":item.get("ResourceId") or None,
                       "provider":item.get("ProviderName") or None,
                       "costType":"IMPORTED_BILLED_UNVERIFIED"})
    return output
def assets(path):
    items,columns=rows(path)
    required(columns,("cost_category","resource_id","monthly_usd","allocation_basis"))
    output=[]
    for number,item in enumerate(items,2):
        category=item["cost_category"].strip().lower()
        if category not in ("hardware","licensing","facilities"):
            raise ValueError(f"asset row {number}: unsupported category")
        amount=money(item["monthly_usd"])
        if amount<0: raise ValueError(f"asset row {number}: negative monthly cost")
        if not item["resource_id"].strip() or not item["allocation_basis"].strip():
            raise ValueError(f"asset row {number}: missing resource or allocation")
        output.append({"category":category,"source":"assets","amountUsd":str(amount),
                       "periodStart":None,"periodEnd":None,"resource":item["resource_id"],
                       "allocationBasis":item["allocation_basis"],"costType":"ALLOCATED_ESTIMATE"})
    return output
def rvtools(path):
    items,columns=rows(path)
    # RVTools worksheet vInfo exported to CSV; inventory is not cost.
    if not any(name in columns for name in ("VM","VM Name","Name")):
        raise ValueError("RVTools CSV needs a VM/VM Name/Name column")
    return {"count":len(items),"columns":sorted(columns),"costAssigned":False}
def collect(args):
    evidence={}
    charges=[]
    inventory=None
    for key,reader in (("focus",focus),("assets",assets)):
        path=getattr(args,key)
        if path:
            charges+=reader(path)
            evidence[key]={"sha256":digest(path),"status":"IMPORTED_UNVERIFIED"}
        else: evidence[key]={"status":"MISSING"}
    if args.rvtools:
        inventory=rvtools(args.rvtools)
        evidence["rvtools"]={"sha256":digest(args.rvtools),"status":"INVENTORY_ONLY"}
    else: evidence["rvtools"]={"status":"MISSING"}
    totals={category:sum((Decimal(entry["amountUsd"]) for entry in charges if entry["category"]==category),Decimal(0)) for category in CATEGORIES}
    return {"schemaVersion":1,"kind":"ALZ_FINANCIAL_EVIDENCE","mode":"PLAN_ONLY",
            "infrastructureAct":"DISABLED","currency":"USD",
            "sources":evidence,"rvtools":inventory,"records":charges,
            "totalsByCategoryUsd":{k:str(v) for k,v in totals.items()},
            "categoryCoverage":{k:("IMPORTED_UNVERIFIED" if any(x["category"]==k for x in charges) else "UNKNOWN") for k in CATEGORIES},
            "actualCostsVerified":False,"canAuthorizeSpend":False,
            "limitations":["FOCUS rows have not been independently reconciled to provider invoices.",
                           "Monthly asset allocations are not usage-metered actuals.",
                           "Different cost periods and monthly estimates cannot be summed into one period total."]}
def prometheus(report):
    # Only category-level aggregated monthly asset costs; no per-VM cardinality, and no FOCUS sums across periods.
    lines=["# HELP alz_cost_monthly_estimate_usd Imported monthly asset allocation estimates in USD",
           "# TYPE alz_cost_monthly_estimate_usd gauge"]
    for category in ("hardware","licensing","facilities"):
        value=sum((Decimal(x["amountUsd"]) for x in report["records"] if x["category"]==category),Decimal(0))
        lines.append(f'alz_cost_monthly_estimate_usd{{category="{category}"}} {value}')
    return "\n".join(lines)+"\n"
def main():
    p=argparse.ArgumentParser(description=__doc__)
    for flag in ("focus","assets","rvtools"): p.add_argument("--"+flag)
    p.add_argument("--output",required=True)
    p.add_argument("--prometheus-output")
    args=p.parse_args()
    result=collect(args)
    path=Path(args.output)
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(result,indent=2)+"\n")
    if args.prometheus_output:
        dest=Path(args.prometheus_output)
        dest.parent.mkdir(parents=True,exist_ok=True)
        dest.write_text(prometheus(result))
    print("Evidence saved:",path,"| observed billing verified: NO | ACT: DISABLED")
if __name__=="__main__": main()
