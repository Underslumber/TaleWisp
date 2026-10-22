"""Synthetic contracts for universal knowledge compilation and safe retrieval."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "knowledge_structure", ROOT / "plugin/scripts/knowledge_structure.py")
knowledge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(knowledge)


def fixture(root: Path) -> dict:
    snapshot = root / "snapshots" / "source.txt"
    snapshot.parent.mkdir(parents=True)
    snapshot.write_text(
        "Flow means current A.\nFlow means current B.\n"
        "Cell stores measured charge.\nEngine consumes cell energy.\nGrid consumes cell energy.\n"
        "Academy teaches shaping.\nShaping is a method.\n"
        "A seed moved from a donor to a receiver.\n"
        "Mara is a servant.\nMara is the killer.\n"
        "The speaker enters quietly.\n"
        "Flow A and Flow B are distinct.\n"
        "The first description says the tower stands north.\n"
        "The corrected description says the tower stands south.\n"
        "The tower later fell during the storm.\n"
        "A storm gathers.\n"
        "The reader learns the lighthouse code at coordinate seven.\n"
        "The pilot taught the archivist the route.\n",
        encoding="utf-8")
    digest = hashlib.sha256(snapshot.read_bytes()).hexdigest()

    def definition(did, text, *, world=None, version=None, validity=None,
                   reader="public", holders=None, author=True, basis="source statement"):
        return {"id": did, "text": text, "basis": basis, "status": "accepted",
                "world_scope": world, "version_scope": version, "validity": validity,
                "disclosure": {"reader": reader, "holders": holders or [], "author": author},
                "evidence": [{"source_id": "source-a", "quote": text, "locator": "fixture line"}]}

    nodes = [
        {"id": "system:flow-a", "title": "Flow", "type": "power-system", "role": "current A",
         "aliases": ["flow-A"], "definitions": [definition("def-flow-a", "Flow means current A.", world=["world-a"])]},
        {"id": "system:flow-b", "title": "Flow", "type": "power-system", "role": "current B",
         "aliases": ["flow-B"], "definitions": [definition("def-flow-b", "Flow means current B.", world=["world-b"])]},
        {"id": "resource:cell", "title": "Cell", "type": "resource", "role": "energy source",
         "aliases": ["cell core"], "definitions": [definition("def-cell", "Cell stores measured charge.")]},
        {"id": "device:engine", "title": "Engine", "type": "device", "role": "consumer",
         "aliases": [], "definitions": [definition("def-engine", "Engine consumes cell energy.")]},
        {"id": "infra:grid", "title": "Grid", "type": "infrastructure", "role": "consumer",
         "aliases": [], "definitions": [definition("def-grid", "Grid consumes cell energy.")]},
        {"id": "institution:academy", "title": "Academy", "type": "institution", "role": "teacher",
         "aliases": [], "definitions": [definition("def-academy", "Academy teaches shaping.")]},
        {"id": "method:shaping", "title": "Shaping", "type": "method", "role": "taught method",
         "aliases": [], "definitions": [definition("def-shaping", "Shaping is a method.")]},
        {"id": "person:donor", "title": "Donor", "type": "person", "role": "event participant",
         "aliases": [], "definitions": [definition("def-donor", "The pilot taught the archivist the route.")]},
        {"id": "person:receiver", "title": "Receiver", "type": "person", "role": "event participant",
         "aliases": [], "definitions": [definition("def-receiver", "The pilot taught the archivist the route.")]},
        {"id": "object:seed", "title": "Seed", "type": "object", "role": "transferred object",
         "aliases": [], "definitions": [definition("def-seed", "A seed moved from a donor to a receiver.")]},
        {"id": "person:hidden-heir", "title": "Mara", "type": "person", "role": "secret bearer",
         "aliases": [{"text": "the killer", "disclosure": {"reader": "hidden", "holders": [], "author": True}}],
         "label_disclosure": {"reader": "public", "holders":[{"id":"keeper", "mode":"known", "timeline":"world-time", "at":0}], "author":True},
         "definitions": [definition("def-mara-public", "Mara is a servant."), definition(
             "def-hidden-heir", "Mara is the killer.", reader="hidden",
             holders=[{"id": "keeper", "mode": "known", "timeline": "world-time", "at": 8}])]},
        {"id": "person:masked", "title": "Secret Witness", "type": "person", "role": "hidden role",
         "aliases": [{"text": "the witness", "disclosure": {"reader": "hidden", "holders": [], "author": True}}],
         "label_disclosure": {"reader": "hidden", "holders": [], "author": True},
         "definitions": [definition("def-masked", "The speaker enters quietly.")]},
        {"id": "fact:lighthouse", "title": "Lighthouse Code", "type": "fact", "role": "revealed clue",
         "aliases": [], "definitions": [definition(
             "def-lighthouse", "The reader learns the lighthouse code at coordinate seven.",
             world=["world-a"], version=["edition-1"],
             validity={"timeline": "world-time", "from": 2, "to": 10},
             reader={"timeline": "world-time", "at": 7})]},
        {"id": "nav:public", "title": "Public Glossary", "type": "category", "role": "navigation",
         "aliases": ["secret-alias-must-not-leak"], "public_navigation": True, "definitions": []},
        {"id": "claim:tower-north", "title": "North description", "type": "claim", "role": "earlier description",
         "aliases": [], "definitions": [definition("def-tower-north", "The first description says the tower stands north.", version=["edition-1"], basis="edition statement")]},
        {"id": "claim:tower-south", "title": "South description", "type": "claim", "role": "corrected description",
         "aliases": [], "definitions": [definition("def-tower-south", "The corrected description says the tower stands south.", version=["edition-2"], basis="editorial correction")]},
        {"id": "place:tower", "title": "Tower", "type": "place", "role": "world object",
         "aliases": [], "definitions": [definition("def-tower", "The tower later fell during the storm.",
             validity={"timeline": "world-time", "from": 9, "to": None})]},
        {"id": "weather:storm", "title": "Storm", "type": "weather", "role": "world event",
         "aliases": [], "definitions": [definition("def-storm", "A storm gathers.")]},
    ]
    public = {"reader": "public", "holders": [], "author": True}
    for node in nodes:
        node.setdefault("label_disclosure", public)
    for ident in ("resource:cell", "device:engine", "person:donor", "person:receiver", "object:seed"):
        node = next(n for n in nodes if n["id"] == ident)
        grants = [{"id": "keeper", "mode": "known", "timeline": "world-time", "at": 0}]
        node["label_disclosure"] = {**node["label_disclosure"], "holders": grants}
        for definition_row in node["definitions"]:
            definition_row["disclosure"] = {**definition_row["disclosure"], "holders": grants}
    relations = []
    def relation(rid, source, target, predicate, *, direction="directed", disclosure=None, quote="Cell stores measured charge."):
        relations.append({"id": rid, "source": source, "target": target,
                          "predicate": predicate, "direction": direction,
                          "world_scope": None, "version_scope": None, "validity": None,
                          "disclosure": disclosure or public,
                          "evidence": [{"source_id": "source-a", "quote": quote}]})
    relation("rel-engine-cell", "device:engine", "resource:cell", "uses", quote="Engine consumes cell energy.")
    relations[-1].update(status="disputed", conditions="only while enabled", exceptions=["fails without a cell"])
    relations[-1]["disclosure"] = {"reader": "public", "holders": [
        {"id": "keeper", "mode": "known", "timeline": "world-time", "at": 2}], "author": True}
    relation("rel-grid-cell", "infra:grid", "resource:cell", "uses", quote="Grid consumes cell energy.")
    relation("rel-academy-method", "institution:academy", "method:shaping", "teaches", quote="Academy teaches shaping.")
    relation("rel-hidden", "person:donor", "person:receiver", "teaches",
             disclosure={"reader": "hidden", "holders": [], "author": True},
             quote="A seed moved from a donor to a receiver.")
    relation("rel-flow-distinct", "system:flow-a", "system:flow-b", "distinct_from", direction="symmetric",
             quote="Flow A and Flow B are distinct.")
    relation("rel-tower-supersedes", "claim:tower-south", "claim:tower-north", "supersedes",
             quote="The corrected description says the tower stands south.")
    return {
        "schema": knowledge.SCHEMA,
        "sources": [{"id": "source-a", "path": "snapshots/source.txt", "sha256": digest}],
        "nodes": nodes,
        "views": [
            {"id": "systems", "title": "Systems", "placements": [
                {"node_id": "system:flow-a", "parent_id": None, "axis": "power systems", "basis": "Separate source definition."},
                {"node_id": "system:flow-b", "parent_id": None, "axis": "power systems", "basis": "Separate source definition."},
                {"node_id": "resource:cell", "parent_id": None, "axis": "resources", "basis": "Source identifies stored charge."},
            ]},
            {"id": "technology", "title": "Technology", "placements": [
                {"node_id": "resource:cell", "parent_id": None, "axis": "resources", "basis": "Shared by devices."},
                {"node_id": "device:engine", "parent_id": "resource:cell", "axis": "uses resource", "basis": "View groups power source and consumer."},
            ]},
        ],
        "predicates": [
            {"name": "uses", "meaning": "uses resource", "source_role": "consumer", "target_role": "resource", "direction": "directed", "cycles": "allow", "transitive": False},
            {"name": "teaches", "meaning": "teaches method", "source_role": "teacher", "target_role": "method", "direction": "directed", "cycles": "allow", "transitive": False},
            {"name": "distinct_from", "meaning": "is explicitly a different identity from", "source_role": "identity", "target_role": "identity", "direction": "symmetric", "cycles": "allow", "transitive": False},
            {"name": "supersedes", "meaning": "editorial description replaces another description", "source_role": "later description", "target_role": "earlier description", "direction": "directed", "cycles": "forbid", "transitive": False},
        ],
        "relations": relations,
        "events": [{"id": "event:transfer", "title": "Seed transfer",
                     "participants": [{"node_id": "person:donor", "role": "sender"},
                                      {"node_id": "person:receiver", "role": "recipient"},
                                      {"node_id": "object:seed", "role": "transferred object"}],
                     "world_scope": None, "version_scope": None, "validity": None,
                     "disclosure": {"reader": "hidden", "holders": [{"id": "keeper", "mode": "known", "timeline": "world-time", "at": 3}], "author": True},
                     "conditions": "Only while the holder consents.",
                     "result": "The recipient holds the seed.",
                     "evidence": [{"source_id": "source-a", "quote": "A seed moved from a donor to a receiver."}]},
                    {"id": "event:tower-fall", "title": "Tower falls in storm",
                     "participants": [{"node_id": "place:tower", "role": "affected place"},
                                      {"node_id": "weather:storm", "role": "cause"}],
                     "world_scope": ["world-a"], "version_scope": None,
                     "validity": {"timeline": "world-time", "from": 9, "to": None},
                     "disclosure": public,
                     "conditions": "only after the storm begins", "exceptions": ["does not apply to the old tower"],
                     "evidence": [{"source_id": "source-a", "quote": "The tower later fell during the storm."}]}],
        "redirects": {"resource:old-cell": "resource:cell"},
    }


class KnowledgeStructureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.spec = fixture(self.root)
        self.index = knowledge.compile_structure(self.spec, self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_unknown_fields_are_rejected_at_every_fixed_record_boundary(self):
        node = next(i for i, row in enumerate(self.spec["nodes"]) if row["id"] == "person:hidden-heir")
        lighthouse = next(i for i, row in enumerate(self.spec["nodes"]) if row["id"] == "fact:lighthouse")
        event = next(i for i, row in enumerate(self.spec["events"]) if row["id"] == "event:transfer")
        cases = [
            ((), "spec", "spec"),
            (("sources", 0), "sources[0]", "sources[0]"),
            (("nodes", 0, "definitions", 0, "evidence", 0), "definition def-flow-a.evidence[0]", "evidence"),
            (("nodes", lighthouse, "definitions", 0, "validity"), "definition def-lighthouse.validity", "validity"),
            (("nodes", lighthouse, "definitions", 0, "disclosure", "reader"), "definition def-lighthouse.disclosure.reader", "reader coordinate"),
            (("nodes", lighthouse, "definitions", 0, "disclosure"), "definition def-lighthouse.disclosure", "disclosure"),
            (("nodes", node, "label_disclosure", "holders", 0), "node person:hidden-heir.label_disclosure.holders[0]", "holder"),
            (("nodes", node), f"nodes[{node}]", "node"),
            (("nodes", node, "definitions", 0), f"nodes[{node}].definitions[0]", "definition"),
            (("nodes", node, "aliases", 0), f"nodes[{node}].aliases[0]", "alias"),
            (("views", 0), "views[0]", "view"),
            (("views", 0, "placements", 0), "views[0].placements[0]", "placement"),
            (("predicates", 0), "predicates[0]", "predicate"),
            (("events", event, "participants", 0), f"event event:transfer.participants[0]", "participant"),
        ]
        for path, where, label in cases:
            with self.subTest(record=label):
                bad = json.loads(json.dumps(self.spec))
                target = bad
                for part in path:
                    target = target[part]
                target["unsupported_key"] = True
                with self.assertRaises(knowledge.KnowledgeStructureError) as caught:
                    knowledge.compile_structure(bad, self.root)
                self.assertIn(where, str(caught.exception))
                self.assertIn("unsupported_key", str(caught.exception))

    def test_definition_conditions_and_exceptions_are_explicitly_rejected(self):
        for key in ("conditions", "exceptions"):
            with self.subTest(key=key):
                bad = json.loads(json.dumps(self.spec))
                bad["nodes"][0]["definitions"][0][key] = "must not be silently discarded"
                with self.assertRaises(knowledge.KnowledgeStructureError) as caught:
                    knowledge.compile_structure(bad, self.root)
                self.assertIn("nodes[0].definitions[0]", str(caught.exception))
                self.assertIn(key, str(caught.exception))

    def test_independent_worlds_same_term_shared_resource_and_distinct_views(self):
        a = knowledge.query_structure(self.index, "current", {"audience": "reader", "world": "world-a"})
        b = knowledge.query_structure(self.index, "current", {"audience": "reader", "world": "world-b"})
        self.assertEqual([n["id"] for n in a["results"]], ["system:flow-a"])
        self.assertEqual([n["id"] for n in b["results"]], ["system:flow-b"])
        self.assertEqual([v["id"] for v in self.index["views"]], ["systems", "technology"])
        self.assertEqual([r["source"] for r in self.index["relations"] if r["target"] == "resource:cell"],
                         ["device:engine", "infra:grid"])
        self.assertEqual(len([n for n in self.index["nodes"] if n["id"] == "resource:cell"]), 1)
        self.assertEqual([n["id"] for n in knowledge.query_structure(self.index, "magic")["results"]], [])

    def test_roles_types_open_predicates_and_nary_event_survive(self):
        engine = next(n for n in self.index["nodes"] if n["id"] == "device:engine")
        self.assertEqual(engine["type"], "device")
        method = next(n for n in self.index["nodes"] if n["id"] == "method:shaping")
        self.assertEqual(method["role"], "taught method")
        event = next(e for e in self.index["events"] if e["id"] == "event:transfer")
        self.assertEqual(len(event["participants"]), 3)
        self.assertIn("conditions", event)
        self.assertEqual({p["name"] for p in self.index["predicates"]}, {"uses", "teaches", "distinct_from", "supersedes"})
        results = knowledge.query_structure(self.index, "charge")
        self.assertEqual({r["id"] for r in results["relations"]}, {"rel-engine-cell", "rel-grid-cell"})
        engine_relation = next(r for r in results["relations"] if r["id"] == "rel-engine-cell")
        self.assertEqual(engine_relation["status"], "disputed")
        self.assertEqual(engine_relation["conditions"], "only while enabled")
        self.assertEqual(engine_relation["exceptions"], ["fails without a cell"])

    def test_editorial_supersession_stays_separate_from_world_change(self):
        first = knowledge.query_structure(self.index, "north", {"audience": "reader", "version": "edition-1"})
        second = knowledge.query_structure(self.index, "south", {"audience": "reader", "version": "edition-2"})
        self.assertEqual([r["id"] for r in first["results"]], ["claim:tower-north"])
        self.assertEqual([r["id"] for r in second["results"]], ["claim:tower-south"])
        self.assertEqual([r["id"] for r in first["relations"]], ["rel-tower-supersedes"])
        before = knowledge.query_structure(self.index, "fell", {"audience": "reader", "world": "world-a", "time": {"timeline": "world-time", "at": 8}})
        after = knowledge.query_structure(self.index, "fell", {"audience": "reader", "world": "world-a", "time": {"timeline": "world-time", "at": 9}})
        self.assertEqual(before["results"], [])
        self.assertEqual([r["id"] for r in after["results"]], ["place:tower"])
        self.assertEqual([e["id"] for e in after["events"]], ["event:tower-fall"])
        self.assertEqual(after["events"][0]["conditions"], "only after the storm begins")
        self.assertEqual(after["events"][0]["exceptions"], ["does not apply to the old tower"])

    def test_holder_projection_preserves_known_vs_believed_without_holder_ids(self):
        context = {"audience": "holder", "holder": "keeper", "time": {"timeline": "world-time", "at": 4}}
        definition_result = knowledge.query_structure(self.index, "charge", context)
        self.assertEqual(definition_result["results"][0]["definitions"][0]["access_mode"], "known")
        relation = next(r for r in definition_result["relations"] if r["id"] == "rel-engine-cell")
        self.assertEqual(relation["access_mode"], "known")
        event_result = knowledge.query_structure(self.index, "route", context)
        event = next(e for e in event_result["events"] if e["id"] == "event:transfer")
        self.assertEqual(event["access_mode"], "known")
        self.assertNotIn("keeper", str({"definition": definition_result, "event": event_result}))

        changed = json.loads(json.dumps(self.spec))
        cell = next(n for n in changed["nodes"] if n["id"] == "resource:cell")
        next(d for d in cell["definitions"] if d["id"] == "def-cell")["disclosure"]["holders"][0]["mode"] = "believed"
        next(r for r in changed["relations"] if r["id"] == "rel-engine-cell")["disclosure"] = {
            "reader": "public", "holders": [{"id": "keeper", "mode": "believed", "timeline": "world-time", "at": 2}], "author": True}
        next(e for e in changed["events"] if e["id"] == "event:transfer")["disclosure"]["holders"][0]["mode"] = "believed"
        changed_index = knowledge.compile_structure(changed, self.root)
        changed_definition = knowledge.query_structure(changed_index, "charge", context)
        self.assertEqual(changed_definition["results"][0]["definitions"][0]["access_mode"], "believed")
        self.assertEqual(next(r for r in changed_definition["relations"] if r["id"] == "rel-engine-cell")["access_mode"], "believed")
        changed_event = knowledge.query_structure(changed_index, "route", context)
        self.assertEqual(next(e for e in changed_event["events"] if e["id"] == "event:transfer")["access_mode"], "believed")
        unauthorized = knowledge.query_structure(self.index, "charge", {**context, "holder": "stranger"})
        self.assertEqual(unauthorized["results"], [])

    def test_relation_and_event_reject_unsupported_semantic_fields(self):
        bad = json.loads(json.dumps(self.spec))
        bad["relations"][0]["only_while"] = "enabled"
        with self.assertRaisesRegex(knowledge.KnowledgeStructureError, "Unsupported fields"):
            knowledge.compile_structure(bad, self.root)
        bad = json.loads(json.dumps(self.spec))
        bad["events"][0]["unmodeled_claim"] = "must not vanish"
        with self.assertRaisesRegex(knowledge.KnowledgeStructureError, "Unsupported fields"):
            knowledge.compile_structure(bad, self.root)
        bad = json.loads(json.dumps(self.spec))
        bad["relations"][0]["status"] = ""
        with self.assertRaisesRegex(knowledge.KnowledgeStructureError, "status must be a string"):
            knowledge.compile_structure(bad, self.root)

    def test_stable_identity_on_rename_reparent_and_reused_title(self):
        changed = json.loads(json.dumps(self.spec))
        changed["nodes"][2]["title"] = "Stored Charge"
        changed["views"][0]["placements"][2]["parent_id"] = None
        changed["views"][1]["placements"][0]["parent_id"] = "system:flow-a"
        changed["views"][1]["placements"].append({"node_id": "system:flow-a", "parent_id": None,
            "axis": "power systems", "basis": "Separate source definition."})
        index = knowledge.compile_structure(changed, self.root)
        cell = next(n for n in index["nodes"] if n["id"] == "resource:cell")
        self.assertEqual(cell["title"], "Stored Charge")
        self.assertEqual(cell["id"], "resource:cell")
        self.assertEqual(next(n for n in index["nodes"] if n["id"] == "system:flow-a")["title"], "Flow")

    def test_disclosure_holder_time_world_and_version_fail_closed(self):
        secret = "Mara is the killer."
        for query in ("the killer", "Mara is the killer."):
            self.assertEqual(knowledge.query_structure(self.index, query)["results"], [])
        holder_before = knowledge.query_structure(self.index, secret,
            {"audience": "holder", "holder": "keeper", "time": {"timeline": "world-time", "at": 7}})
        holder_after = knowledge.query_structure(self.index, secret,
            {"audience": "holder", "holder": "keeper", "time": {"timeline": "world-time", "at": 8}})
        self.assertEqual(holder_before["results"], [])
        self.assertEqual([r["id"] for r in holder_after["results"]], ["person:hidden-heir"])
        reader = {"audience": "reader", "world": "world-a", "version": "edition-1",
                  "time": {"timeline": "world-time", "at": 7}}
        self.assertEqual([r["id"] for r in knowledge.query_structure(self.index, "lighthouse", reader)["results"]],
                         ["fact:lighthouse"])
        for context in (
            {"audience": "reader", "world": "world-a", "version": "edition-1"},
            {**reader, "world": "world-b"}, {**reader, "version": "edition-2"},
            {**reader, "time": {"timeline": "other", "at": 7}},
            {**reader, "time": {"timeline": "world-time", "at": "before"}},
        ):
            self.assertEqual(knowledge.query_structure(self.index, "lighthouse", context)["results"], [])
        self.assertEqual(knowledge.query_structure(self.index, "Mara is the killer.", {"audience": "reader"})["results"], [])
        author = knowledge.query_structure(self.index, secret, {"audience": "author"})
        self.assertEqual([r["id"] for r in author["results"]], ["person:hidden-heir"])
        with self.assertRaises(knowledge.KnowledgeStructureError):
            knowledge.query_structure(self.index, secret, {"audience": "reader", "author": True})

    def test_public_navigation_is_explicit_and_does_not_expose_alias(self):
        result = knowledge.query_structure(self.index, "Public Glossary")
        self.assertEqual(result["results"], [{"id": "nav:public", "title": "Public Glossary",
            "public_navigation": True}])
        self.assertEqual(knowledge.query_structure(self.index, "secret-alias-must-not-leak")["results"], [])

    def test_hidden_node_labels_do_not_attach_to_public_definition_hits(self):
        result = knowledge.query_structure(self.index, "enters quietly")
        self.assertEqual(result["results"], [{"definitions": [{"text": "The speaker enters quietly.",
            "basis": "source statement", "status": "accepted"}]}])
        for query in ("Secret Witness", "the witness"):
            self.assertEqual(knowledge.query_structure(self.index, query)["results"], [])

    def test_hidden_relations_and_events_are_not_projected(self):
        result = knowledge.query_structure(self.index, "route")
        self.assertEqual(result["events"], [])
        self.assertNotIn("rel-hidden", {r["id"] for r in result["relations"]})
        self.assertNotIn("A seed moved from a donor to a receiver.", str(result))

    def test_literal_evidence_hash_and_source_root_are_mandatory(self):
        bad = json.loads(json.dumps(self.spec))
        bad["nodes"][0]["definitions"][0]["evidence"][0]["quote"] = "Approximate paraphrase."
        with self.assertRaisesRegex(knowledge.KnowledgeStructureError, "exact substring"):
            knowledge.compile_structure(bad, self.root)
        bad = json.loads(json.dumps(self.spec))
        bad["sources"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(knowledge.KnowledgeStructureError, "hash mismatch"):
            knowledge.compile_structure(bad, self.root)
        bad = json.loads(json.dumps(self.spec))
        bad["sources"][0]["path"] = "../source.txt"
        with self.assertRaisesRegex(knowledge.KnowledgeStructureError, "safe source_root-relative"):
            knowledge.compile_structure(bad, self.root)

    def test_parent_dangling_alias_redirect_and_predicate_cycles_are_rejected(self):
        bad = json.loads(json.dumps(self.spec))
        bad["views"][0]["placements"][0]["parent_id"] = "missing"
        with self.assertRaisesRegex(knowledge.KnowledgeStructureError, "Unknown node endpoint"):
            knowledge.compile_structure(bad, self.root)
        bad = json.loads(json.dumps(self.spec))
        bad["views"][0]["placements"][0]["parent_id"] = "system:flow-b"
        bad["views"][0]["placements"][1]["parent_id"] = "system:flow-a"
        with self.assertRaisesRegex(knowledge.KnowledgeStructureError, "Parent cycle"):
            knowledge.compile_structure(bad, self.root)
        bad = json.loads(json.dumps(self.spec))
        bad["redirects"] = {"old-a": "old-b", "old-b": "old-a"}
        with self.assertRaisesRegex(knowledge.KnowledgeStructureError, "Redirect cycle"):
            knowledge.compile_structure(bad, self.root)
        bad = json.loads(json.dumps(self.spec))
        bad["redirects"] = {"old-a": "missing"}
        with self.assertRaisesRegex(knowledge.KnowledgeStructureError, "Redirect chain does not resolve"):
            knowledge.compile_structure(bad, self.root)
        bad = json.loads(json.dumps(self.spec))
        bad["nodes"].append({"id": "extra", "title": "Extra", "type": "test", "role": "",
                             "definitions": [bad["nodes"][0]["definitions"][0]]})
        with self.assertRaisesRegex(knowledge.KnowledgeStructureError, "Duplicate"):
            knowledge.compile_structure(bad, self.root)

    def test_forbidden_predicate_cycle_and_direction_mismatch_are_rejected(self):
        bad = json.loads(json.dumps(self.spec))
        bad["predicates"][0]["cycles"] = "forbid"
        bad["relations"].append({**bad["relations"][0], "id": "rel-reverse", "source": "resource:cell",
                                 "target": "device:engine", "world_scope": ["world-a"]})
        with self.assertRaisesRegex(knowledge.KnowledgeStructureError, "relationship cycle"):
            knowledge.compile_structure(bad, self.root)
        disjoint = json.loads(json.dumps(self.spec))
        disjoint["predicates"][0]["cycles"] = "forbid"
        disjoint["relations"][0]["world_scope"] = ["world-b"]
        disjoint["relations"].append({**disjoint["relations"][0], "id": "rel-disjoint-reverse",
            "source": "resource:cell", "target": "device:engine", "world_scope": ["world-a"]})
        self.assertEqual(knowledge.compile_structure(disjoint, self.root)["schema"], knowledge.SCHEMA)
        bad = json.loads(json.dumps(self.spec))
        bad["relations"][0]["direction"] = "symmetric"
        with self.assertRaisesRegex(knowledge.KnowledgeStructureError, "direction contradicts"):
            knowledge.compile_structure(bad, self.root)
        bad = json.loads(json.dumps(self.spec))
        bad["predicates"][2]["cycles"] = "forbid"
        with self.assertRaisesRegex(knowledge.KnowledgeStructureError, "supported only for directed"):
            knowledge.compile_structure(bad, self.root)


if __name__ == "__main__":
    unittest.main()
