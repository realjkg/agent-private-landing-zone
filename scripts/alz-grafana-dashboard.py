#!/usr/bin/env python3
"""Produce a provisioning-ready Grafana dashboard JSON for the local Prometheus cost series."""
import argparse
import json
from pathlib import Path

def panel(index,title,expr,description):
    return {"id":index,"title":title,"type":"timeseries",
            "description":description,"datasource":{"type":"prometheus","uid":"${DS_PROMETHEUS}"},
            "targets":[{"refId":"A","expr":expr,"legendFormat":"{{category}}"}],
            "fieldConfig":{"defaults":{"unit":"currencyUSD"},"overrides":[]},
            "gridPos":{"x":0,"y":(index-1)*8,"w":24,"h":8}}
def dashboard():
    return {"__inputs":[{"name":"DS_PROMETHEUS","label":"Prometheus","type":"datasource",
                           "pluginId":"prometheus","pluginName":"Prometheus"}],
            "dashboard":{"id":None,"uid":"sovereign-alz-cost","title":"Sovereign ALZ | Cost Evidence",
                         "tags":["sovereign-alz","financial","evidence"],"timezone":"browser",
                         "schemaVersion":39,"version":1,"refresh":"5m",
                         "panels":[panel(1,"Allocated private costs (monthly)",
                              "alz_cost_monthly_estimate_usd",
                              "Estimate only; requires an approved source rate card."),
                                   panel(2,"Infrastructure estimate over time",
                              "sum(alz_cost_monthly_estimate_usd)",
                              "Imported allocations, not cloud billing actuals.")],
                         "annotations":{"list":[]}},"overwrite":False}
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",required=True)
    args=parser.parse_args()
    dest=Path(args.output)
    dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_text(json.dumps(dashboard(),indent=2)+"\n")
    print("Grafana dashboard template saved:",dest,"(no deployment)")
if __name__=="__main__":main()
