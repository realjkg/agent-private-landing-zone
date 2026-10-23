import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

MODULE=Path(__file__).resolve().parents[1]/"scripts"/"alz-cost-import.py"
spec=importlib.util.spec_from_file_location("cost_import",MODULE)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class CostEvidenceTests(unittest.TestCase):
    def test_categories_no_false_actuals(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/"assets.csv"
            p.write_text("cost_category,resource_id,monthly_usd,allocation_basis\nhardware,cluster-01,2500,allocated_capacity\nlicensing,cluster-01,1200,allocated_vcpu\nfacilities,cluster-01,420,measured_usage\n")
            result=mod.collect(SimpleNamespace(focus=None,assets=str(p),rvtools=None))
            self.assertEqual(result["totalsByCategoryUsd"]["hardware"],"2500")
            self.assertEqual(result["categoryCoverage"]["cloud"],"UNKNOWN")
            self.assertFalse(result["actualCostsVerified"])
            self.assertIn("alz_cost_monthly_estimate_usd",mod.prometheus(result))
    def test_focus_reject_currency_mismatch(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/"focus.csv"
            p.write_text("BilledCost,BillingCurrency,ChargePeriodStart,ChargePeriodEnd\n4.2,EUR,2026-10-01T00:00:00Z,2026-10-02T00:00:00Z\n")
            with self.assertRaisesRegex(ValueError,"USD conversion"):
                mod.focus(p)
    def test_rvtools_inventory_not_cost(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/"vInfo.csv"
            p.write_text("VM,Powerstate\nvm1,poweredOn\n")
            self.assertFalse(mod.rvtools(p)["costAssigned"])
    def test_zero_or_unknown_does_not_prove_savings(self):
        result=mod.collect(SimpleNamespace(focus=None,assets=None,rvtools=None))
        self.assertEqual(result["categoryCoverage"]["hardware"],"UNKNOWN")
        self.assertFalse(result["canAuthorizeSpend"])

if __name__=="__main__": unittest.main()
