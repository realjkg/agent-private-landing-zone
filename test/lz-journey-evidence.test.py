import hashlib,importlib.util,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location("runner",Path(__file__).resolve().parents[1]/"scripts/lz-journey-evidence.py")
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class Tests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.root=Path(self.t.name)
  self.m={"source_sha":"a"*40,"engine":"TERRAFORM","mode":"PREVIEW_OPERATE","act_enabled":False,"stages":{}}
  for stage in r.STAGES:
   p=self.root/(stage+".json");p.write_text("{}")
   self.m["stages"][stage]={"path":p.name,"sha256":hashlib.sha256(p.read_bytes()).hexdigest(),"source_sha":"a"*40,"engine":"TERRAFORM","authentic":True,"verified_by":"owner"}
 def test_complete_requires_review(self):
  result=r.assess(self.m,self.root);self.assertTrue(result["structural_evidence_complete"]);self.assertEqual(result["production_authorization"],"NOT_GRANTED")
 def test_missing(self):
  del self.m["stages"]["private_models"];self.assertFalse(r.assess(self.m,self.root)["structural_evidence_complete"])
 def test_hash(self):
  (self.root/"discovery.json").write_text("changed");self.assertFalse(r.assess(self.m,self.root)["structural_evidence_complete"])
 def test_engine(self):
  self.m["stages"]["iac_preview"]["engine"]="CDK";self.assertFalse(r.assess(self.m,self.root)["structural_evidence_complete"])
 def test_act(self):
  self.m["act_enabled"]=True;self.assertFalse(r.assess(self.m,self.root)["structural_evidence_complete"])
 def test_escape(self):
  self.m["stages"]["inventory"]["path"]="../outside";self.assertFalse(r.assess(self.m,self.root)["structural_evidence_complete"])
 def test_html(self):
  self.assertNotIn("<script>",r.render({"stages":[{"stage":"<script>","status":"BLOCKED","detail":"x"}]}))
if __name__=="__main__":unittest.main()
