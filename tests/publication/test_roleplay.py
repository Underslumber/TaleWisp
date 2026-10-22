import hashlib
import copy
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest
import os

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = Path(os.environ.get('TALEWISP_TEST_PLUGIN_ROOT', ROOT / 'plugin'))


SCRIPT = PLUGIN / "scripts/roleplay.py"
SPEC = importlib.util.spec_from_file_location("roleplay_test", SCRIPT)
rp = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(rp)


class RoleplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.project = Path(self.temp.name) / "project"
        self.vault = self.project / "vault"
        self.vault.mkdir(parents=True)
        self.source = self.vault / "world.md"
        self.lines = {
            "rules": "Магические печати открывают только каменные двери.",
            "limits": "Печать не действует на деревянные двери.",
            "traits": "Лея терпелива и наблюдательна.",
            "motives": "Лея хочет защитить младшего брата.",
            "goals": "Лея ищет лекарство для брата.",
            "knowledge": "Лея знает знак старого лекаря.",
            "starting_state": "Лея стоит у каменной двери.",
            "time": "Это происходит на рассвете.",
            "viewpoint": "Сцена показана через восприятие Леи.",
            "constraints": "Лея не может позвать стражу без риска для брата.",
        }
        self.source.write_text("\n".join(f"P{i:04d} {value}" for i, value in enumerate(self.lines.values(), 1)) + "\n", encoding="utf-8")
        self.spec = self.make_spec()
        self.attach_context_v2()
        self.session = "branch_test"

    def tearDown(self):
        self.temp.cleanup()

    def make_spec(self):
        source_bytes = self.source.read_bytes()
        groups = {
            "world": {"rules": ["rules"], "limits": ["limits"]},
            "hero": {"traits": ["traits"], "motives": ["motives"], "goals": ["goals"], "knowledge": ["knowledge"]},
            "scene": {"starting_state": ["starting_state"], "time": ["time"], "viewpoint": ["viewpoint"], "constraints": ["constraints"]},
        }
        declarations = {}
        for group, fields in groups.items():
            declarations[group] = {}
            for field, keys in fields.items():
                declarations[group][field] = [{"value": self.lines[key], "source_refs": [{"source_id": "source1", "fragment_id": key}]} for key in keys]
        return {"branch_id": "branch_a", "hero_id": "hero_leya", "series_id": "series_one",
                "story_time": {"id": "book1_chapter3", "label": "Глава 3, рассвет", "ordinal": 1},
                "sources": [{"source_id": "source1", "path": "world.md", "sha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
                             "fragments": [{"fragment_id": key, "quote": value} for key, value in self.lines.items()]}],
                **declarations,
                "scene_context": {"hero_position": {"value": "Лея стоит перед каменной дверью.", "branch_assumption": "Unit-test staging only."},
                    "hero_activity": {"value": "Лея изучает знак у двери.", "branch_assumption": "Unit-test staging only."},
                    "hero_initial_context": [{"value": self.lines["starting_state"], "source_refs": [{"source_id": "source1", "fragment_id": "starting_state"}]}],
                    "leader_only_context": [{"value": "An NPC must have a plausible route to the door.", "branch_assumption": "Unit-test staging only."}]},
                "craft_input": {"leader": ["Keep cause and perception clear."], "hero": ["Connect perception to personal meaning and action."],
                                "formatter": ["Preserve the played reaction and action."]},
                "semantic_review": {"status": "author_confirmed", "reviewer": "author"}}

    def attach_context_v2(self, target_spec=None):
        target_spec = target_spec or self.spec
        context_path = PLUGIN / "scripts/roleplay_context.py"
        context_spec = importlib.util.spec_from_file_location("roleplay_context_fixture", context_path)
        context = importlib.util.module_from_spec(context_spec)
        context_spec.loader.exec_module(context)
        constraints = [{"id": f"c{i}", "text": self.lines[key]} for i, key in enumerate(self.lines, 1) if i <= 6]
        runtime_context = copy.deepcopy(target_spec.get("scene_context"))
        unit_by_fragment = {("source1", key): f"P{index:04d}" for index, key in enumerate(self.lines, 1)}
        for value in (runtime_context or {}).values():
            entries = value if isinstance(value, list) else [value]
            for entry in entries:
                if isinstance(entry, dict):
                    for ref in entry.get("source_refs", []):
                        ref["fragment_id"] = unit_by_fragment.get((ref["source_id"], ref["fragment_id"]), ref["fragment_id"])
        read_scope = []
        for source in target_spec["sources"]:
            source_id, path = source["source_id"], source["path"]
            if source_id == "source1":
                first_id, last_id = "P0001", "P0010"
            else:
                content = (self.vault / path).read_text(encoding="utf-8")
                ids = re.findall(r"(?m)^\s*(?:#{1,6}\s*)?((?:[A-Z]\d{1,3}-C\d{1,3}-P\d{1,6}|[A-Z]\d{1,3}[A-Z]?-[M]\d{1,6}|D\d{1,3}[A-Z]?-[M]\d{1,6}|P\d{1,6}|M\d{1,6}))(?:\s|[-–—:]|$)", content)
                first_id, last_id = ids[0], ids[-1]
                for fragment, uid in zip(source["fragments"], ids):
                    unit_by_fragment[(source_id, fragment["fragment_id"])] = uid
            read_scope.append({"source_id": source_id, "path": path, "first_id": first_id, "last_id": last_id})
        for value in (runtime_context or {}).values():
            entries = value if isinstance(value, list) else [value]
            for entry in entries:
                if isinstance(entry, dict):
                    for ref in entry.get("source_refs", []):
                        ref["fragment_id"] = unit_by_fragment.get((ref["source_id"], ref["fragment_id"]), ref["fragment_id"])
        target_map = {"rules": "world.rules", "limits": "world.limits", "traits": "hero.traits", "motives": "hero.motives", "goals": "hero.goals", "knowledge": "hero.knowledge"}
        request = {"context_version": 2, "assembly_run_id": "assembly_fixture", "allow_roleplay": True,
                   "author_constraints": constraints,
                   "read_scope": read_scope,
                   "runtime": {"branch_id": target_spec["branch_id"], "hero_id": target_spec["hero_id"], "series_id": target_spec["series_id"],
                               "story_time": target_spec["story_time"],
                               "scene_context": runtime_context,
                                "unknown_dispositions": {},
                               "staging": {key: target_spec["scene"][key][0]["value"] for key in ("starting_state", "time", "viewpoint", "constraints")},
                               "craft_input": target_spec["craft_input"], "scene_design": target_spec.get("scene_design", {})}}
        source_packet = context.prepare_context(self.vault, request)["source_packet"]
        facts = []
        facts_by_unit = {}
        for i, (key, value) in enumerate(self.lines.items(), 1):
            roles = ["leader"] if key in {"rules", "limits"} else ["leader", "hero"]
            facts.append({"id": key, "claim": value, "status": "active",
                          "target": target_map.get(key),
                          "evidence": [{"source_id": "source1", "unit_id": f"P{i:04d}", "quote": value}],
                          "author_constraint_ids": [f"c{i}"] if i <= 6 else [],
                          "known_to": roles, "required_roles": roles,
                          "scene_influence": f"{key} changes what the hero can do."})
            facts_by_unit[f"source1#P{i:04d}"] = key
        for source in source_packet["sources"]:
            for unit in source["units"]:
                unit_key = f"{source['source_id']}#{unit['unit_id']}"
                if unit_key not in facts_by_unit:
                    fact_id = f"fact_{source['source_id']}_{unit['unit_id']}"
                    facts.append({"id": fact_id, "claim": unit["text"], "status": "active", "target": None,
                                  "evidence": [{"source_id": source["source_id"], "unit_id": unit["unit_id"], "quote": unit["text"]}],
                                  "author_constraint_ids": [], "known_to": ["leader"], "required_roles": ["leader"],
                                  "scene_influence": "Leader-only source context affects scene understanding."})
                    facts_by_unit[unit_key] = fact_id
        inventory = {"context_version": 2, "request": request, "facts": facts,
                     "unit_coverage": [{"source_id": s["source_id"], "unit_id": u["unit_id"],
                                         "fact_ids": [facts_by_unit[f"{s['source_id']}#{u['unit_id']}"]], "excluded_parts": []}
                                       for s in source_packet["sources"] for u in s["units"]],
                     "conflicts": [], "unknowns": []}
        request["runtime"]["kernel"] = [
            {"id": "hero_goal", "layer": "hero", "slot": "goal", "ref": {"fact_id": "goals"}, "holder": ["hero", "leader"]},
            {"id": "goal_tension", "layer": "scene", "slot": "tension", "ref": {"scene_context": {"field": "hero_activity"}}, "holder": ["hero", "leader"], "links": [{"rel": "informs", "to": "hero_goal"}]},
            {"id": "npc_guard", "layer": "leader", "slot": "npc", "ref": {"scene_context": {"field": "leader_only_context", "index": 0}}, "motive_ref": {"scene_context": {"field": "leader_only_context", "index": 0}}, "access_ref": {"scene_context": {"field": "leader_only_context", "index": 0}}, "background": True},
        ]
        inventory["role_packets"] = context.build_role_packets(inventory)
        packets = inventory["role_packets"]
        hashes = [context.canonical_sha256(x) for x in (request, source_packet, inventory, packets)]
        receipt = {"schema_version": 1, "run_id": "independent_fixture_review", "identity": "fixture-reviewer",
                   "provenance": "trusted_host_review", "request_sha256": hashes[0],
                   "source_packet_sha256": hashes[1], "inventory_sha256": hashes[2],
                   "role_packets_sha256": hashes[3], "findings": [], "blockers": []}
        receipt_dir = self.project / ".talewisp/context-audits"
        receipt_dir.mkdir(parents=True, exist_ok=True)
        (receipt_dir / "audit_fixture.json").write_text(json.dumps(receipt), encoding="utf-8")
        target_spec.update({"context_version": 2, "request": request, "inventory": inventory,
                          "semantic_audit": {"receipt_id": "audit_fixture"}})

    def lines_key_for_index(self, index):
        return list(self.lines)[index - 1]
        declarations = {}
        for group, fields in groups.items():
            declarations[group] = {}
            for field, keys in fields.items():
                declarations[group][field] = [
                    {"value": self.lines[key], "source_refs": [{"source_id": "source1", "fragment_id": key}]}
                    for key in keys
                ]
        return {
            "branch_id": "branch_a", "hero_id": "hero_leya", "series_id": "series_one",
            "story_time": {"id": "book1_chapter3", "label": "Глава 3, рассвет", "ordinal": 1},
            "sources": [{"source_id": "source1", "path": "world.md",
                         "sha256": hashlib.sha256(source_bytes).hexdigest(),
                         "fragments": [{"fragment_id": key, "quote": value} for key, value in self.lines.items()]}],
            **declarations,
            "scene_context": {
                "hero_position": {"value": "Лея стоит перед каменной дверью.", "branch_assumption": "Unit-test staging only."},
                "hero_activity": {"value": "Лея изучает знак у двери.", "branch_assumption": "Unit-test staging only."},
                "hero_initial_context": [{"value": self.lines["starting_state"],
                    "source_refs": [{"source_id": "source1", "fragment_id": "starting_state"}]}],
                "leader_only_context": [{"value": "An NPC must have a plausible route to the door.",
                    "branch_assumption": "Unit-test staging only."}],
            },
            "craft_input": {
                "leader": ["Keep cause and perception clear."],
                "hero": ["Connect perception to personal meaning and action."],
                "formatter": ["Preserve the played reaction and action."],
            },
            "semantic_review": {"status": "author_confirmed", "reviewer": "author"},
        }

    def call(self, action, **kwargs):
        if action == "hero_action" and "stimulus_ref" not in kwargs:
            kwargs["stimulus_ref"] = "own_initiative"
        if action == "start" and isinstance(kwargs.get("spec"), dict):
            self.attach_context_v2(kwargs["spec"])
        return rp.dispatch(self.project, self.vault, action,
                           {"session_id": self.session, **kwargs})

    def start(self):
        return self.call("start", spec=self.spec)

    def mutate(self, action, revision, **kwargs):
        if action == "hero_action" and "stimulus_ref" not in kwargs:
            kwargs["stimulus_ref"] = "own_initiative"
        return self.call(action, expected_revision=revision, **kwargs)

    def test_hidden_event_cause_stays_out_of_hero_history_status_and_formatter(self):
        status = self.start()
        status = self.call("situation", expected_revision=status["revision"], text="Слышны шаги.",
            revealed_to_hero=["Шаги приближаются."], event={"id":"step_event","origin":"environment",
            "cause":{"kind":"hidden","basis":{"kind":"kernel","ref":"hero_goal"},"detail":"hidden-cause-canary"},
            "access":{"channel":"sound","via":"goal_tension","detail":"access-canary"},
            "perceivers":["hero"],"relevance":["hero_goal"],"observations":["Шаги приближаются."]})
        hero = self.call("packet", role="hero")
        self.assertNotIn("hidden-cause-canary", json.dumps(hero, ensure_ascii=False))
        self.assertNotIn("access-canary", json.dumps(hero, ensure_ascii=False))
        self.assertNotIn("hidden-cause-canary", json.dumps(self.call("status"), ensure_ascii=False))
        status = self.call("hero_action", expected_revision=status["revision"], stimulus_ref="step_event", text="Лея замирает.")
        status = self.call("consequence", expected_revision=status["revision"], text="Шаги удаляются.")
        status = self.call("accept_skeleton", expected_revision=status["revision"], accepted=True)
        formatted = self.call("packet", role="formatter", voice_input={"voice":"selected"})
        self.assertIn("step_event", json.dumps(formatted, ensure_ascii=False))
        self.assertNotIn("hidden-cause-canary", json.dumps(formatted, ensure_ascii=False))
        self.assertNotIn("access-canary", json.dumps(formatted, ensure_ascii=False))

    def test_issue_pauses_and_invalidates_acceptance_without_dispatch(self):
        status=self.start()
        status=self.call("issue", expected_revision=status["revision"], text="Cause path is unsupported.", category="causality")
        self.assertEqual(status["run_state"],"paused")
        self.assertEqual(self.call("status")["issues"][0]["status"], "open")
        with self.assertRaisesRegex(rp.RoleplayError,"paused or stopped"):
            self.call("situation", expected_revision=status["revision"], text="Follow-up")
        resumed=self.call("resume", expected_revision=status["revision"])
        self.assertEqual(resumed["run_state"],"active")
        self.assertEqual(resumed["phase"],"situation")
        self.assertEqual(self.call("packet",role="leader")["issues"][0]["category"],"causality")
        self.assertNotIn("issues",self.call("packet",role="hero"))

    def test_open_issue_blocks_reacceptance_and_finish_without_changing_played_turn(self):
        status=self.start()
        status=self.call("situation",expected_revision=status["revision"],text="A mark glows.")
        status=self.call("hero_action",expected_revision=status["revision"],text="Lea watches the mark.")
        status=self.call("consequence",expected_revision=status["revision"],text="The light fades.")
        status=self.call("accept_skeleton",expected_revision=status["revision"],accepted=True)
        accepted_revision=status["skeleton_accepted_content_revision"]
        status=self.call("issue",expected_revision=status["revision"],text="The turn contradicts the entry state.",category="continuity")
        self.assertIsNone(status["skeleton_accepted_content_revision"])
        self.assertNotEqual(status["skeleton_accepted_content_revision"],accepted_revision)
        paused_state=rp._load(self.project/".talewisp/roleplay/branch_test.json")
        self.assertEqual(len(paused_state["turns"]),1)
        self.assertEqual(paused_state["turns"][0]["hero_action"],"Lea watches the mark.")
        status=self.call("resume",expected_revision=status["revision"])
        before=rp._load(self.project/".talewisp/roleplay/branch_test.json")
        with self.assertRaisesRegex(rp.RoleplayError,"issue is open"):
            self.call("accept_skeleton",expected_revision=status["revision"],accepted=True)
        self.assertEqual(rp._load(self.project/".talewisp/roleplay/branch_test.json"),before)
        forged=copy.deepcopy(before)
        forged["skeleton_accepted_content_revision"]=forged["content_revision"]
        rp._save(self.project/".talewisp/roleplay/branch_test.json",forged)
        revision=forged["revision"]
        with self.assertRaisesRegex(rp.RoleplayError,"issue is open"):
            self.call("finish",expected_revision=revision)
        self.assertEqual(rp._load(self.project/".talewisp/roleplay/branch_test.json"),forged)

    def test_issue_requires_nonempty_category_without_mutation(self):
        self.assertTrue(rp._has_open_issues({"issues":[{"text":"Legacy issue has no status."}]}))
        status=self.start()
        before=rp._load(self.project/".talewisp/roleplay/branch_test.json")
        for category in (None,"  "):
            with self.subTest(category=category),self.assertRaises(rp.RoleplayError):
                self.call("issue",expected_revision=status["revision"],text="A bounded issue.",category=category)
            self.assertEqual(rp._load(self.project/".talewisp/roleplay/branch_test.json"),before)

    def test_legacy_shaped_hero_packet_handles_none_index_and_absent_v2_fields(self):
        self.start()
        path=self.project/".talewisp/roleplay/branch_test.json"
        state=rp._load(path)
        state["fact_target_index"]=None
        state.pop("kernel",None)
        state["role_context_packets"]=None
        rp._save(path,state)
        packet=self.call("packet",role="hero")
        self.assertEqual(packet["semantic_kernel"],[])

    def test_runtime_hero_projection_uses_actual_role_packets_and_suppresses_accepted_delta(self):
        status=self.start()
        packet=self.call("packet",role="hero")
        goal=next(item for item in packet["semantic_kernel"] if item["id"]=="hero_goal")
        self.assertEqual(goal["text"],self.lines["goals"])
        status=self.call("probe_answer",expected_revision=status["revision"],probe_id="choice_under_pressure",answer="A test hypothesis.")
        status=self.call("accept_probe_delta",expected_revision=status["revision"],probe_id="choice_under_pressure",author_delta={"goals":["Lea chooses a different goal."]})
        packet=self.call("packet",role="hero")
        self.assertNotIn("hero_goal",{item["id"] for item in packet["semantic_kernel"]})

    def test_runtime_leader_packet_preserves_two_npc_motive_and_access_bindings(self):
        self.start()
        path=self.project/".talewisp/roleplay/branch_test.json"
        state=rp._load(path)
        context=state["scene_context"]
        context["leader_only_context"]=[
            {"value":"An NPC must have a plausible route to the door."},
            {"value":"NPC identity: Sera."},{"value":"NPC identity: Dain."},
            {"value":"Motive: protect her sister."},{"value":"Access: holds the courtyard key."},
            {"value":"Motive: sell a route to a rival."},{"value":"Access: enters through the drainage passage."},
        ]
        npcs=[
            {"id":"sera","layer":"leader","slot":"npc","ref":{"scene_context":{"field":"leader_only_context","index":1}},
             "motive_ref":{"scene_context":{"field":"leader_only_context","index":3}},
             "access_ref":{"scene_context":{"field":"leader_only_context","index":4}},"background":True},
            {"id":"dain","layer":"leader","slot":"npc","ref":{"scene_context":{"field":"leader_only_context","index":2}},
             "motive_ref":{"scene_context":{"field":"leader_only_context","index":5}},
             "access_ref":{"scene_context":{"field":"leader_only_context","index":6}},"background":True},
        ]
        state["kernel"].extend(npcs)
        rp._semantics().validate_kernel(state["kernel"],self.spec["inventory"],context)
        rp._save(path,state)
        leader=self.call("packet",role="leader")
        by_id={item["id"]:item for item in leader["semantic_kernel"]}
        self.assertEqual((by_id["sera"]["text"],by_id["sera"]["motive"],by_id["sera"]["access"]),
                         ("NPC identity: Sera.","Motive: protect her sister.","Access: holds the courtyard key."))
        self.assertEqual((by_id["dain"]["text"],by_id["dain"]["motive"],by_id["dain"]["access"]),
                         ("NPC identity: Dain.","Motive: sell a route to a rival.","Access: enters through the drainage passage."))
        hero_json=json.dumps(self.call("packet",role="hero"),ensure_ascii=False)
        for private in ("protect her sister","courtyard key","sell a route","drainage passage"):
            self.assertNotIn(private,hero_json)
        state=rp._load(path)
        updated=[item for item in state["kernel"] if item.get("id") in {"sera","dain"}]
        updated[0]["motive_ref"],updated[1]["motive_ref"]=updated[1]["motive_ref"],updated[0]["motive_ref"]
        updated[0]["access_ref"],updated[1]["access_ref"]=updated[1]["access_ref"],updated[0]["access_ref"]
        rp._semantics().validate_kernel(state["kernel"],self.spec["inventory"],state["scene_context"])
        rp._save(path,state)
        swapped=self.call("packet",role="leader")
        swapped_by_id={item["id"]:item for item in swapped["semantic_kernel"]}
        self.assertEqual(swapped_by_id["sera"]["motive"],"Motive: sell a route to a rival.")
        self.assertEqual(swapped_by_id["sera"]["access"],"Access: enters through the drainage passage.")
        self.assertEqual(swapped_by_id["dain"]["motive"],"Motive: protect her sister.")
        self.assertEqual(swapped_by_id["dain"]["access"],"Access: holds the courtyard key.")

    def test_leader_packet_includes_all_saved_unknowns(self):
        self.start()
        path=self.project/".talewisp/roleplay/branch_test.json"
        state=rp._load(path)
        expected=[{"id":name,"gap":f"Gap for {name}","blocks_when":f"When {name} matters"}
                  for name in ("weather","visibility","pose","loot_remainder")]
        state["unknowns"]=expected
        rp._save(path,state)
        packet=self.call("packet",role="leader")
        self.assertEqual(packet["unknowns"],expected)

    def test_dispatch_rejects_invalid_event_and_meaning_refs_without_mutating_branch(self):
        status=self.start()
        status=self.call("probe_answer",expected_revision=status["revision"],probe_id="choice_under_pressure",answer="A test hypothesis.")
        status=self.call("accept_probe_delta",expected_revision=status["revision"],probe_id="choice_under_pressure",author_delta={"goals":["Lea chooses a different goal."]})
        status=self.call("situation",expected_revision=status["revision"],text="A guard hears a knock.",revealed_to_hero=[],
                         event={"id":"npc_only_evt","origin":"environment","cause":{"kind":"kernel","ref":"hero_goal"},
                                "access":{"channel":"sound","via":"hero_goal","detail":"The guard hears it."},
                                "perceivers":["npc:npc_guard"],"relevance":"ambient","observations":[]})
        path=self.project/".talewisp/roleplay/branch_test.json"
        for stimulus in ("npc_only_evt","future_evt","foreign_branch_evt"):
            before=rp._load(path)
            with self.subTest(stimulus=stimulus),self.assertRaises(ValueError):
                self.call("hero_action",expected_revision=status["revision"],stimulus_ref=stimulus,text="Lea turns.")
            self.assertEqual(rp._load(path),before)
        for meaning in ("npc_guard","unknown_kernel_id","hero_goal"):
            before=rp._load(path)
            with self.subTest(meaning=meaning),self.assertRaises(rp.RoleplayError):
                self.call("hero_action",expected_revision=status["revision"],stimulus_ref="own_initiative",meaning_ref=meaning,text="Lea turns.")
            self.assertEqual(rp._load(path),before)

    def test_v2_start_without_kernel_is_rejected_without_creating_branch(self):
        spec=copy.deepcopy(self.spec)
        spec["request"]["runtime"].pop("kernel")
        ready=rp.readiness(self.project,self.vault,spec)
        self.assertFalse(ready["scene_context_complete"])
        self.assertTrue(any("runtime.kernel" in item for item in ready["scene_context_issues"]))
        with self.assertRaisesRegex(rp.RoleplayError,"complete scene_context"):
            rp.dispatch(self.project,self.vault,"start",{"session_id":self.session,"spec":spec})
        self.assertFalse((self.project/".talewisp/roleplay/branch_test.json").exists())

    def test_role_contracts_keep_complete_sentences_after_kernel_additions(self):
        self.assertIn("current context and available knowledge; choose the immediate goal",rp.HERO_CONTRACT)
        self.assertIn("Use the semantic kernel only as source-backed entry context",rp.HERO_CONTRACT)
        self.assertNotIn("current Use the semantic kernel",rp.HERO_CONTRACT)
        self.assertIn("information. Preserve the hero's played perception",rp.FORMATTER_CONTRACT)
        self.assertIn("judgment. Use scene_design only",rp.LEADER_CONTRACT)

    def test_roleplay_contracts_encode_epistemic_pressure_and_relationship_rules(self):
        self.assertIn("Missing host, model, or source-ledger data does not establish that an NPC is ignorant", rp.LEADER_CONTRACT)
        self.assertIn("self-report as that character's claim, not verified world fact", rp.LEADER_CONTRACT)
        self.assertIn("goal, pressure, deadline, and limits on trusted alternatives", rp.LEADER_CONTRACT)
        self.assertIn("interest, cost, or constraint", rp.LEADER_CONTRACT)
        self.assertIn("does not require threats, sarcasm, or a fixed outcome", rp.LEADER_CONTRACT)
        self.assertIn("Preserve an established form of address and social register", rp.HERO_CONTRACT)
        self.assertIn("does not require obedience, agreement, or any specific outcome", rp.HERO_CONTRACT)
        for fragment in (
            "missing host, model, or source-ledger data has not been turned into NPC ignorance",
            "self-report attributed as a claim rather than verified world fact",
            "address and social register against established relationship evidence",
            "each active NPC's goal, pressure, deadline, and trusted alternatives",
            "concession through the NPC's own interest, cost, or constraint",
        ):
            self.assertIn(fragment, rp.HOST_REVIEW_CHECKLIST)
        for contract in (rp.LEADER_CONTRACT, rp.HERO_CONTRACT, rp.HOST_REVIEW_CHECKLIST):
            for character_name in ("Беал", "Баст", "Маркус"):
                self.assertNotIn(character_name, contract)

        self.start()
        leader = self.call("packet", role="leader")
        hero = self.call("packet", role="hero")
        self.assertIn("goal, pressure, deadline", leader["contract"])
        self.assertIn("address and social register", leader["host_review_checklist"])
        self.assertIn("established form of address and social register", hero["contract"])
        self.assertNotIn("host_review_checklist", hero)

        root = ROOT
        for source, mirror in (
            ("plugin/scripts/roleplay.py", "plugins/talewisp/scripts/roleplay.py"),
            ("plugin/skills/write-fiction/references/roleplay-mode.md", "plugins/talewisp/skills/write-fiction/references/roleplay-mode.md"),
            ("plugin/skills/write-fiction/references/roleplay-dramaturgy.md", "plugins/talewisp/skills/write-fiction/references/roleplay-dramaturgy.md"),
        ):
            if (root / mirror).exists():
                self.assertEqual((root / source).read_bytes(), (root / mirror).read_bytes())

    def test_kernel_check_rejects_bad_input_shapes_and_non_declaration_context(self):
        with self.assertRaisesRegex(rp.RoleplayError,"runtime and inventory"):
            rp.dispatch(self.project,self.vault,"kernel_check",{"runtime":[],"inventory":{}})
        with self.assertRaisesRegex(rp.RoleplayError,"scene_context"):
            rp.dispatch(self.project,self.vault,"kernel_check",{"runtime":{"kernel":[],"scene_context":"bad"},"inventory":{}})
        runtime=copy.deepcopy(self.spec["request"]["runtime"])
        runtime["scene_context"]["hero_activity"]="not a declaration"
        with self.assertRaises(ValueError):
            rp.dispatch(self.project,self.vault,"kernel_check",{"runtime":runtime,"inventory":self.spec["inventory"]})

    def test_hero_memory_cannot_set_npc_holder_or_basis_event(self):
        for fields in ({"holder":"npc:guard"},{"basis_event":"evt"}):
            with self.subTest(fields=fields),self.assertRaisesRegex(rp.RoleplayError,"Hero memory updates"):
                rp._validated_memory_updates([{"kind":"fact","text":"A concrete memory.",**fields}],"turn:1")
        accepted=rp._validated_memory_updates([{"kind":"fact","text":"A concrete NPC memory.","holder":"npc:guard","basis_event":"evt"}],"turn:1",include_holder=True)
        self.assertEqual(accepted[0]["holder"],"npc:guard")

    def test_sparse_placeholder_and_wrong_source_fragment_do_not_pass(self):
        sparse = dict(self.spec)
        sparse.pop("context_version", None); sparse.pop("request", None); sparse.pop("inventory", None); sparse.pop("semantic_audit", None)
        sparse["hero"] = dict(sparse["hero"])
        sparse["hero"]["motives"] = [{"value": "TODO: motive goes here", "source_refs": [{"source_id": "source1", "fragment_id": "rules"}]}]
        with self.assertRaises(rp.RoleplayError):
            rp.readiness(self.project, self.vault, sparse)
        unrelated = dict(self.spec)
        unrelated.pop("context_version", None); unrelated.pop("request", None); unrelated.pop("inventory", None); unrelated.pop("semantic_audit", None)
        unrelated["hero"] = dict(unrelated["hero"])
        unrelated["hero"]["motives"] = [{"value": "Лея хочет защитить младшего брата.",
                                          "source_refs": [{"source_id": "source1", "fragment_id": "missing_fragment"}]}]
        with self.assertRaises(rp.RoleplayError):
            rp.readiness(self.project, self.vault, unrelated)

    def test_new_scene_contract_can_come_from_current_author_instruction(self):
        spec = dict(self.spec)
        spec.pop("context_version", None); spec.pop("request", None); spec.pop("inventory", None); spec.pop("semantic_audit", None)
        for field in ("starting_state", "time", "viewpoint", "constraints"):
            claim = spec["scene"][field][0]
            spec["scene"][field] = [{"value": claim["value"], "author_instruction": claim["value"]}]
        result = rp.readiness(self.project, self.vault, spec)
        self.assertFalse(result["offerable"])
        self.assertEqual(result["readiness_status"], "needs_context_audit")
        self.assertEqual(result["field_source_coverage"]["scene"]["starting_state"], ["author_instruction"])

    def test_ready_fixture_checks_exact_source_hash_and_explicit_review(self):
        result = rp.readiness(self.project, self.vault, self.spec)
        self.assertTrue(result["structural_complete"])
        self.assertTrue(result["offerable"])
        legacy = dict(self.spec)
        legacy.pop("context_version", None); legacy.pop("request", None); legacy.pop("inventory", None); legacy.pop("semantic_audit", None)
        legacy["semantic_review"] = {"status": "source_reviewed"}
        self.assertFalse(rp.readiness(self.project, self.vault, legacy)["offerable"])
        self.assertEqual(rp.readiness(self.project, self.vault, legacy)["readiness_status"], "needs_context_audit")

    def test_start_and_reload_keep_branch_separate_and_hero_packet_secret_free(self):
        self.start()
        path = self.project / ".talewisp/roleplay/branch_test.json"
        persisted = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["hero_memory"][0]["provenance"], "character_source")
        self.assertEqual(self.call("status")["revision"], 1)
        leader = self.call("packet", role="leader")
        self.assertEqual(leader["world"]["rules"][0]["value"], self.lines["rules"])
        self.assertEqual(leader["world"]["rules"][0]["source_refs"], [{"source_id": "source1", "fragment_id": "P0001"}])
        self.assertEqual(leader["hero_declarations"]["knowledge"][0]["value"], self.lines["knowledge"])
        self.assertIn("Ask whether changing or removing this hero action", leader["contract"])
        self.assertIn("Resolve each attempt with a concrete result, obstacle, or limit", leader["contract"])
        self.assertIn("Keep ordinary necessary substeps together unless a meaningful obstacle requires a new hero choice", leader["contract"])
        self.assertIn("do not perform the next distinct choice for the hero", leader["contract"])
        self.assertIn("do not repeat a static question or invent an observation", leader["contract"])
        self.assertIn("actor, recipient, event time, and knowledge owner explicit", leader["contract"])
        self.assertIn("Include causes or relationships already experienced and known to the hero by entry", leader["contract"])
        self.assertIn("keep events actually future at entry out", leader["contract"])
        self.assertIn("Never guess who a pronoun refers to", leader["contract"])
        self.assertIn("leave ownership unresolved if still unclear", leader["contract"])
        self.assertIn("do not infer NPC memory", leader["contract"])
        self.assertIn("neutral and uneventful", leader["contract"])
        self.assertIn("meaningful result or decision", leader["contract"])
        self.assertIn("resolve actual access or acquisition and fit to the hero's body and the material", leader["contract"])
        self.assertIn("Do not make them therapists or default to forgiveness or absolution", leader["contract"])
        self.assertIn("hidden hero feelings are not public knowledge without such evidence", leader["contract"])
        self.assertIn("do not state a precise symptomatic guess as fact", leader["contract"])
        self.assertIn("grant inventory or abilities by fiat", leader["contract"])
        self.assertIn("changing or removing it", leader["host_review_checklist"])
        self.assertIn("incomplete", leader["host_review_checklist"])
        self.assertIn("was the actual attempt", leader["host_review_checklist"])
        self.assertIn("Orders, apologies, and ordinary politeness remain allowed when earned", leader["host_review_checklist"])
        self.assertIn("Dialogue, hesitation, jokes", leader["host_review_checklist"])
        self.assertIn("must not default to atmosphere", leader["host_review_checklist"])
        self.assertIn("speaker, recipient, and personal context", leader["host_review_checklist"])
        self.assertIn("Keep leader-only hero-private facts", leader["host_review_checklist"])
        self.assertIn("not an automatic semantic validator", leader["host_review_checklist"])
        checklist = leader["host_review_checklist"]
        self.assertIn("actor, recipient, event time, and knowledge owner explicit", checklist)
        self.assertIn("scope the unknown to that gap and do not infer NPC memory", checklist)
        self.assertIn("concrete result, obstacle, or limit", checklist)
        self.assertIn("do not invent an observation for a small physical attempt", checklist)
        self.assertIn("current self-image, and relationship habits", checklist)
        self.assertIn("not a required endpoint", checklist)
        self.assertIn("own current purpose, interests, and established relationship habits", checklist)
        self.assertIn("No compulsory therapy or forgiveness", checklist)
        self.assertNotIn("did at least one concrete significant fact change", checklist)
        self.assertIn("Keep ordinary necessary substeps together", checklist)
        self.assertIn("do not perform that next choice for them", checklist)
        self.assertIn("Orders, apologies, and ordinary politeness remain allowed when earned", checklist)
        self.assertIn("do not prescribe aggression or an emotional performance", checklist)
        self.assertIn("own current purpose, interests, and established relationship habits", checklist)
        self.assertIn("do not force passivity or repeat offers by default", checklist)
        self.assertIn("Treat unobserved hero feelings as private", checklist)
        self.assertIn("never state a precise symptom inferred from hidden input as fact", checklist)
        self.assertIn("Include in hero entry causes or relationships already experienced and known by that time", checklist)
        self.assertIn("exclude events that are future at entry", checklist)
        hero = self.call("packet", role="hero")
        self.assertIn("Translate relevant constraints", hero["contract"])
        self.assertIn("Speech, disclosure", hero["contract"])
        self.assertIn("without requiring any particular form", hero["contract"])
        self.assertIn("briefly and quietly compare the proposed action with", hero["contract"])
        self.assertIn("whether the choice follows a local benefit, necessity", hero["contract"])
        self.assertIn("does not require narrated analysis, a ledger", hero["contract"])
        self.assertIn("conditions of relevant resources or protections that the hero actually knows", hero["contract"])
        self.assertIn("necessity, an established character impulse, or a plausible mistake", hero["contract"])
        self.assertIn("need not anticipate every cost", hero["contract"])
        self.assertIn("what the character perceives and what it means to them", hero["contract"])
        self.assertIn("shaped by their current motives and self-image", hero["contract"])
        self.assertIn("do not require a narrated appraisal or expressive gesture", hero["contract"])
        self.assertIn("Remorse or change is possible when grounded, never a required endpoint", hero["contract"])
        self.assertIn("do not script confession or moral re-evaluation", hero["contract"])
        self.assertIn("Ordinary means need not be pre-listed in inventory", hero["contract"])
        self.assertIn("the leader resolves the attempt", hero["contract"])
        self.assertNotIn("host_review_checklist", hero)
        self.assertNotIn(rp.HOST_REVIEW_CHECKLIST, json.dumps(hero, ensure_ascii=False))
        serialized = json.dumps(hero, ensure_ascii=False)
        for secret in ("world.md", "source1", self.lines["rules"], self.lines["limits"], "revision", "branch_id"):
            self.assertNotIn(secret, serialized)
        self.assertIn(self.lines["knowledge"], serialized)
        self.assertFalse(any((self.vault / "canon.md").exists() for _ in [0]))

    def test_packets_supply_resource_guidance_and_issue_preserves_attempt(self):
        status = self.start()
        status = self.mutate("situation", status["revision"], text="A hidden warning is useful only while unknown.",
                             revealed_to_hero=["The warning's usefulness depends on remaining unknown."])
        attempt = "Лея сообщает встречному, где находится средство, полезное только пока оно неизвестно, без местной причины."
        status = self.mutate("hero_action", status["revision"], text=attempt)
        leader = self.call("packet", role="leader")
        self.assertEqual(leader["turns"][-1]["hero_action"], attempt)
        checklist = leader["host_review_checklist"]
        self.assertIn("Before delivering the current hero attempt to the leader", checklist)
        self.assertIn("record an issue with the issue action and pause", checklist)
        self.assertIn("do not rewrite it or invent a motive", checklist)
        self.assertIn("basis for the action may be a concrete local benefit", checklist)
        self.assertIn("actually known to the hero", checklist)
        self.assertIn("necessity, an established character impulse, or a plausible mistake", checklist)
        self.assertIn("Reject only an ungrounded contradiction, not a bad result", checklist)
        self.assertIn("hero need not anticipate the cost", checklist)
        status = self.mutate("issue", status["revision"], category="resource-condition",
                             text="Attempt defeats a relevant usefulness condition without grounded local benefit.")
        self.assertEqual(status["run_state"], "paused")
        persisted = json.loads((self.project / ".talewisp/roleplay/branch_test.json").read_text(encoding="utf-8"))
        self.assertEqual(persisted["turns"][-1]["hero_action"], attempt)
        self.assertEqual(persisted["issues"][-1]["category"], "resource-condition")

    def test_fresh_hero_packet_keeps_safe_observation_history_and_orders_changed_state(self):
        status = self.start()
        status = self.mutate("situation", status["revision"], text="Перед Леей ярко горит костёр.",
                             revealed_to_hero=["Костёр горит."])
        status = self.mutate("hero_action", status["revision"], text="Лея протягивает руки к огню.")
        status = self.mutate("consequence", status["revision"], text="Ведущий меняет состояние мира.",
                             leader_memory_updates=[{"kind": "fact", "text": "Скрытый секрет архива.", "certainty": "observed"}])
        status = self.mutate("situation", status["revision"], text="Собеседник отвечает Лее.",
                             revealed_to_hero=["Костёр погас."])
        packet = self.call("packet", role="hero")
        self.assertEqual([item["turn"] for item in packet["situation_history"]], [1, 2])
        self.assertEqual(packet["situation_history"][0]["revealed_observations"], ["Костёр горит."])
        self.assertEqual(packet["situation_history"][0]["hero_action_attempted"], "Лея протягивает руки к огню.")
        self.assertEqual(packet["situation_history"][1]["text"], "Собеседник отвечает Лее.")
        self.assertEqual(packet["current_situation"]["revealed_to_hero"], ["Костёр погас."])
        self.assertIn("later observation", packet["perception_rule"])
        serialized = json.dumps(packet, ensure_ascii=False)
        self.assertNotIn("Скрытый секрет архива", serialized)
        self.assertNotIn("Ведущий меняет состояние мира", serialized)

    def test_source_drift_blocks_status_and_resumed_work(self):
        self.start()
        self.source.write_text(self.source.read_text(encoding="utf-8") + "Изменение источника.\n", encoding="utf-8")
        with self.assertRaisesRegex(rp.RoleplayError, "drift"):
            self.call("status")

    def test_turn_phases_revision_pause_resume_and_formatting_acceptance(self):
        status = self.start()
        with self.assertRaisesRegex(rp.RoleplayError, "Expected phase"):
            self.mutate("hero_action", 1, text="Лея поворачивает печать.")
        status = self.mutate("situation", 1, text="У двери слышны шаги.", revealed_to_hero=["За дверью кто-то есть."])
        self.assertEqual(status["phase"], "hero_action")
        with self.assertRaisesRegex(rp.RoleplayError, "Stale"):
            self.mutate("hero_action", 1, text="Старая попытка.")
        hero = self.call("packet", role="hero")
        self.assertEqual(hero["revealed_observations"], ["За дверью кто-то есть."])
        status = self.mutate("hero_action", status["revision"], text="Лея прикладывает печать.")
        status = self.mutate("consequence", status["revision"], text="Печать нагревается, но дверь не открывается.",
                             memory_updates=[{"kind": "belief", "text": "Дверь может быть деревянной.", "certainty": "inferred"}],
                             leader_memory_updates=[{"kind": "fact", "text": "За дверью лежит тайный архив.", "certainty": "observed"}])
        self.assertEqual(status["phase"], "situation")
        self.assertNotIn("тайный архив", json.dumps(self.call("packet", role="hero"), ensure_ascii=False))
        with self.assertRaisesRegex(rp.RoleplayError, "accepted current skeleton"):
            self.call("packet", role="formatter", voice_input={"voice": "selected"})
        status = self.mutate("pause", status["revision"])
        with self.assertRaisesRegex(rp.RoleplayError, "paused"):
            self.mutate("situation", status["revision"], text="Не должно записаться.")
        status = self.mutate("resume", status["revision"])
        self.assertEqual(status["phase"], "situation")  # Resume did not dispatch a role.
        status = self.mutate("stop", status["revision"])
        status = self.mutate("resume", status["revision"])
        status = self.mutate("accept_skeleton", status["revision"], accepted=True)
        packet = self.call("packet", role="formatter", voice_input={"selected_voice": "author style rules"})
        self.assertEqual(packet["accepted_skeleton"]["turns"][0]["hero_action"], "Лея прикладывает печать.")
        self.assertEqual(packet["voice_input"]["selected_voice"], "author style rules")
        self.assertIn("do not add", packet["contract"])
        self.assertIn("When shortening, keep the earned experience", packet["contract"])
        status = self.mutate("finish", status["revision"])
        self.assertEqual(status["run_state"], "finished")
        with self.assertRaisesRegex(rp.RoleplayError, "immutable"):
            self.mutate("situation", status["revision"], text="Finished branches cannot continue.")

    def test_optional_probes_are_not_automatic_and_only_named_author_delta_changes_branch(self):
        probes = self.call("probes")
        self.assertFalse(probes["auto_run"])
        self.assertEqual(len(probes["probes"]), 2)
        self.start()
        original = self.call("packet", role="leader")["hero_declarations"]
        status = self.mutate("probe_answer", 1, probe_id="choice_under_pressure", answer="Лея задерживает стражу ради брата.")
        state = self.mutate("accept_probe_delta", status["revision"], probe_id="choice_under_pressure",
                            author_delta={"motives": ["Сначала защитить брата."]})
        changed = self.call("packet", role="leader")["hero_declarations"]
        self.assertEqual(changed["motives"], [{"value": "Сначала защитить брата."}])
        self.assertEqual(changed["traits"], original["traits"])
        self.assertEqual(self.call("packet", role="hero")["character"]["motives"], [{"value": "Сначала защитить брата."}])
        persisted = json.loads((self.project / ".talewisp/roleplay/branch_test.json").read_text(encoding="utf-8"))
        self.assertEqual(persisted["probe_hypotheses"]["choice_under_pressure"]["status"], "author_corrected")
        self.assertFalse((self.vault / "canon.md").exists())
        self.assertEqual(state["revision"], 3)

    def test_only_finished_accepted_memory_continues_to_later_scene(self):
        self.start()
        status = self.mutate("situation", 1, text="На пороге слышны шаги.", revealed_to_hero=["Шаги приближаются."])
        status = self.mutate("hero_action", status["revision"], text="Лея прячет печать.")
        status = self.mutate("consequence", status["revision"], text="Страж проходит мимо.",
                             memory_updates=[{"kind": "fact", "text": "Страж не заметил Лею.", "certainty": "observed"}],
                             leader_memory_updates=[{"kind": "fact", "text": "В башне спрятан дневник.", "certainty": "observed"}])
        status = self.mutate("probe_answer", status["revision"], probe_id="choice_under_pressure",
                             answer="Лея остаётся ради брата.")
        status = self.mutate("accept_probe_delta", status["revision"], probe_id="choice_under_pressure",
                             author_delta={"traits": ["Лея ставит защиту брата выше личного риска."]})
        status = self.mutate("situation", status["revision"], text="Брат оказывается у закрытой двери.",
                             revealed_to_hero=["Брат стоит рядом с дверью."])
        status = self.mutate("hero_action", status["revision"], text="Лея заслоняет брата.")
        status = self.mutate("consequence", status["revision"], text="Страж отвлекается на Лею.")
        status = self.mutate("accept_skeleton", status["revision"], accepted=True)
        formatted = self.call("packet", role="formatter", voice_input={"voice": "selected"})["accepted_skeleton"]
        self.assertEqual(formatted["turns"][0]["character_state"]["traits"][0]["value"], "Лея терпелива и наблюдательна.")
        self.assertEqual(formatted["turns"][1]["character_state"]["traits"][0]["value"], "Лея ставит защиту брата выше личного риска.")
        self.assertEqual(formatted["initial_character"]["traits"][0]["value"], "Лея терпелива и наблюдательна.")
        status = self.mutate("finish", status["revision"])
        next_spec = json.loads(json.dumps(self.spec, ensure_ascii=False))
        next_spec["branch_id"] = "branch_b"
        next_spec["story_time"] = {"id": "book1_chapter4", "label": "Глава 4", "ordinal": 2}
        self.call("start", spec=next_spec, session_id="branch_next", continue_from_session_id=self.session)
        state = json.loads((self.project / ".talewisp/roleplay/branch_next.json").read_text(encoding="utf-8"))
        texts = [item["text"] for item in state["hero_memory"]]
        self.assertIn("Страж не заметил Лею.", texts)
        self.assertIn("В башне спрятан дневник.", [item["text"] for item in state["leader_memory"]])
        self.assertEqual(state["hero"]["traits"][0]["value"], "Лея ставит защиту брата выше личного риска.")
        self.assertEqual(self.call("packet", role="hero")["character"]["traits"][0]["value"], "Лея ставит защиту брата выше личного риска.")
        self.assertEqual(state["continued_from"]["story_time_id"], "book1_chapter3")
        with self.assertRaisesRegex(rp.RoleplayError, "later integer story_time.ordinal"):
            next_spec["story_time"]["ordinal"] = 1
            self.call("start", session_id="branch_earlier", spec=next_spec, continue_from_session_id=self.session)

    def test_three_scene_continuation_carries_deduplicated_safe_experience_separately(self):
        scene_a = json.loads(json.dumps(self.spec, ensure_ascii=False))
        scene_a["branch_id"] = "branch_a"
        self.call("start", session_id="session_a", spec=scene_a)
        status = self.call("situation", session_id="session_a", expected_revision=1,
                           text="Перед Леей горит костёр.", revealed_to_hero=["Костёр горит."])
        status = self.call("hero_action", session_id="session_a", expected_revision=status["revision"],
                           text="Лея обещает оставить костёр гореть.")
        status = self.call("consequence", session_id="session_a", expected_revision=status["revision"],
                           text="Скрытый результат ведущего A.",
                           leader_memory_updates=[{"kind": "fact", "text": "Тайна ведущего A.", "certainty": "observed"}])
        status = self.call("accept_skeleton", session_id="session_a", expected_revision=status["revision"], accepted=True)
        self.call("finish", session_id="session_a", expected_revision=status["revision"])

        scene_b = json.loads(json.dumps(self.spec, ensure_ascii=False))
        scene_b["branch_id"] = "branch_b"
        scene_b["story_time"] = {"id": "scene_b", "label": "Сцена B", "ordinal": 2}
        self.call("start", session_id="session_b", spec=scene_b, continue_from_session_id="session_a")
        hero_b = self.call("packet", session_id="session_b", role="hero")
        self.assertEqual(hero_b["situation_history"], [])
        self.assertEqual(len(hero_b["past_hero_experience"]), 1)
        self.assertEqual(hero_b["past_hero_experience"][0]["text"], "Перед Леей горит костёр.")
        self.assertEqual(hero_b["past_hero_experience"][0]["hero_action_attempted"], "Лея обещает оставить костёр гореть.")
        self.assertNotIn("Тайна ведущего A", json.dumps(hero_b, ensure_ascii=False))
        status = self.call("situation", session_id="session_b", expected_revision=1,
                           text="Собеседник говорит, что костёр погас.", revealed_to_hero=["Костёр погас."])
        status = self.call("hero_action", session_id="session_b", expected_revision=status["revision"], text="Лея проверяет золу.")
        status = self.call("consequence", session_id="session_b", expected_revision=status["revision"],
                           text="Скрытый результат ведущего B.",
                           leader_memory_updates=[{"kind": "fact", "text": "Тайна ведущего B.", "certainty": "observed"}])
        status = self.call("accept_skeleton", session_id="session_b", expected_revision=status["revision"], accepted=True)
        self.call("finish", session_id="session_b", expected_revision=status["revision"])

        scene_c = json.loads(json.dumps(self.spec, ensure_ascii=False))
        scene_c["branch_id"] = "branch_c"
        scene_c["story_time"] = {"id": "scene_c", "label": "Сцена C", "ordinal": 3}
        self.call("start", session_id="session_c", spec=scene_c, continue_from_session_id="session_b")
        hero_c = self.call("packet", session_id="session_c", role="hero")
        past = hero_c["past_hero_experience"]
        self.assertEqual([(item["source_session_id"], item["turn"]) for item in past], [("session_a", 1), ("session_b", 1)])
        self.assertEqual([item["revealed_observations"] for item in past], [["Костёр горит."], ["Костёр погас."]])
        self.assertEqual(hero_c["situation_history"], [])
        self.assertNotIn("Тайна ведущего A", json.dumps(hero_c, ensure_ascii=False))
        self.assertNotIn("Тайна ведущего B", json.dumps(hero_c, ensure_ascii=False))
        self.assertFalse(any("consequence" in item or "result" in item for item in past))
        status = self.call("situation", session_id="session_c", expected_revision=1,
                           text="Лея снова видит костёр.", revealed_to_hero=["Теперь костёр разгорелся."])
        hero_c_now = self.call("packet", session_id="session_c", role="hero")
        self.assertEqual([item["turn"] for item in hero_c_now["situation_history"]], [1])
        self.assertEqual(hero_c_now["situation_history"][0]["revealed_observations"], ["Теперь костёр разгорелся."])
        self.assertEqual(len(hero_c_now["past_hero_experience"]), 2)
        self.assertIn("historical context", hero_c_now["past_experience_rule"])

    def test_legacy_schema1_branch_without_past_field_can_packet_format_and_continue(self):
        self.start()
        branch_path = self.project / ".talewisp/roleplay/branch_test.json"
        stored = json.loads(branch_path.read_text(encoding="utf-8"))
        self.assertEqual(stored["schema_version"], 1)
        stored.pop("past_hero_experience")
        branch_path.write_text(json.dumps(stored, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        hero = self.call("packet", role="hero")
        leader = self.call("packet", role="leader")
        self.assertEqual(hero["past_hero_experience"], [])
        self.assertIn("past_hero_experience", leader)
        self.assertNotIn("past_hero_experience", json.loads(branch_path.read_text(encoding="utf-8")))

        status = self.mutate("situation", 1, text="Лея видит мокрый след.", revealed_to_hero=["След ещё влажный."])
        status = self.mutate("hero_action", status["revision"], text="Лея проверяет, куда ведёт след.")
        status = self.mutate("consequence", status["revision"], text="След уходит к мосту.")
        status = self.mutate("accept_skeleton", status["revision"], accepted=True)
        formatted = self.call("packet", role="formatter", voice_input={"voice": "selected"})["accepted_skeleton"]
        self.assertEqual(formatted["turns"][0]["situation"]["text"], "Лея видит мокрый след.")
        self.mutate("finish", status["revision"])

        next_spec = json.loads(json.dumps(self.spec, ensure_ascii=False))
        next_spec["branch_id"] = "branch_after_legacy"
        next_spec["story_time"] = dict(next_spec["story_time"], id="later", ordinal=2)
        self.call("start", session_id="session_after_legacy", spec=next_spec,
                  continue_from_session_id=self.session)
        continued = self.call("packet", session_id="session_after_legacy", role="hero")
        self.assertEqual(continued["past_hero_experience"][0]["text"], "Лея видит мокрый след.")
        self.assertEqual(continued["situation_history"], [])

    def test_active_vault_binding_and_series_binding_block_cross_project_memory(self):
        self.start()
        other_vault = self.project / "other-vault"
        other_vault.mkdir()
        with self.assertRaisesRegex(rp.RoleplayError, "different active vault"):
            rp.dispatch(self.project, other_vault, "status", {"session_id": self.session})
        # Make a completed accepted branch to exercise continuation binding.
        status = self.mutate("situation", 1, text="Лея замечает следы.", revealed_to_hero=[])
        status = self.mutate("hero_action", status["revision"], text="Лея осматривает следы.")
        status = self.mutate("consequence", status["revision"], text="Следы ведут к башне.")
        status = self.mutate("accept_skeleton", status["revision"], accepted=True)
        self.mutate("finish", status["revision"])
        changed_series = json.loads(json.dumps(self.spec, ensure_ascii=False))
        changed_series["branch_id"] = "branch_other_series"
        changed_series["series_id"] = "other_series"
        changed_series["story_time"]["ordinal"] = 2
        with self.assertRaisesRegex(rp.RoleplayError, "same hero and series"):
            self.call("start", session_id="other_series_session", spec=changed_series, continue_from_session_id=self.session)

    def test_invalid_ids_paths_and_branch_identity_are_rejected(self):
        with self.assertRaisesRegex(rp.RoleplayError, "Invalid session_id"):
            rp.dispatch(self.project, self.vault, "start", {"session_id": "../escape", "spec": self.spec})
        unsafe = dict(self.spec)
        unsafe["request"] = copy.deepcopy(self.spec["request"])
        unsafe["request"]["read_scope"][0]["path"] = "../outside.md"
        with self.assertRaisesRegex(rp.RoleplayError, "vault-relative"):
            rp.readiness(self.project, self.vault, unsafe)

    def test_mcp_tool_schemas_are_registered_and_ordinary_route_is_untouched(self):
        mcp = PLUGIN / "scripts/talewisp_mcp.py"
        spec = importlib.util.spec_from_file_location("roleplay_mcp_test", mcp)
        module = importlib.util.module_from_spec(spec)
        import sys
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        names = {tool["name"] for tool in module.TOOLS}
        self.assertTrue({"talewisp_roleplay_readiness", "talewisp_roleplay_start", "talewisp_roleplay_packet", "talewisp_roleplay_turn"} <= names)
        self.assertIn("talewisp_save_proposal", names)
        readiness_tool = next(tool for tool in module.TOOLS if tool["name"] == "talewisp_roleplay_readiness")
        status_enum = readiness_tool["inputSchema"]["properties"]["spec"]["properties"]["semantic_review"]["properties"]["status"]["enum"]
        self.assertIn("source_reviewed", status_enum)
        import jsonschema
        spec_schema = readiness_tool["inputSchema"]["properties"]["spec"]
        validator = jsonschema.Draft202012Validator(spec_schema)
        validator.validate({"context_version": 2, "request": {}, "inventory": {}})
        validator.validate({key: value for key, value in self.spec.items()
                            if key not in {"context_version", "request", "inventory", "semantic_audit"}})
        with self.assertRaises(jsonschema.ValidationError):
            validator.validate({"context_version": 3, "request": {}, "inventory": {}})
        start_tool = next(tool for tool in module.TOOLS if tool["name"] == "talewisp_roleplay_start")
        self.assertIn("independent semantic audit", start_tool["description"])
        self.assertIn("do not authorize", start_tool["description"])
        self.assertIn("ordinary", (PLUGIN / "skills/write-fiction/SKILL.md").read_text(encoding="utf-8").casefold())
        turn_tool = next(tool for tool in module.TOOLS if tool["name"] == "talewisp_roleplay_turn")
        turn_properties = turn_tool["inputSchema"]["properties"]
        self.assertIn("set_hero_state", turn_properties["action"]["enum"])
        self.assertEqual(set(turn_properties["hero_state_updates"]["properties"]), {"position", "activity"})


    def test_role_contracts_and_scene_design_are_private_branch_local_and_roundtrip(self):
        self.spec["scene_design"] = {
            "reader_effect": "reader-intent-unique-velvet",
            "dramatic_question": "Will the door open?",
            "relevance_to_hero_goal": "Medicine for her brother",
            "stakes": "Time before dawn",
            "initial_value": "Trust",
            "possible_shift": "Trust may weaken",
            "atmosphere": "Quiet pressure",
        }
        private_source_text = "privateNPC_SENTINEL knows the visitor's hidden motive."
        private_source = self.vault / "private-source.md"
        private_source.write_text("P0100 " + private_source_text + "\n", encoding="utf-8")
        self.spec["sources"].append({
            "source_id": "privateSourceID", "path": "private-source.md",
            "sha256": hashlib.sha256(private_source.read_bytes()).hexdigest(),
            "fragments": [{"fragment_id": "private_fragment", "quote": private_source_text}],
        })
        self.spec["scene_context"]["leader_only_context"] = [{
            "value": private_source_text,
            "source_refs": [{"source_id": "privateSourceID", "fragment_id": "private_fragment"}],
        }]
        self.start()
        leader = self.call("packet", role="leader")
        hero = self.call("packet", role="hero")
        self.assertEqual(leader["scene_design"], self.spec["scene_design"])
        self.assertIn("reader experience", leader["contract"])
        self.assertIn("Adapt to refusal", leader["contract"])
        self.assertIn("Strive to survive", hero["contract"])
        self.assertIn("own established goals", hero["contract"])
        self.assertIn("Risk should have", hero["contract"])
        hero_json = json.dumps(hero, ensure_ascii=False)
        for intent in ("reader-intent-unique-velvet", "Will the door open?", "scene_design"):
            self.assertNotIn(intent, hero_json)

        status = self.mutate("situation", 1, text="Лея замечает потемневший знак.", revealed_to_hero=["Знак потемнел."])
        status = self.mutate("hero_action", status["revision"],
                             text="Лея замечает холод в ладони; тревога сжимает живот, и она медленно касается знака, чтобы проверить его.")
        status = self.mutate("consequence", status["revision"], text="Знак остаётся холодным.")
        status = self.mutate("accept_skeleton", status["revision"], accepted=True)
        formatter = self.call("packet", role="formatter", voice_input={"voice": "selected"})
        self.assertIn("played perception", formatter["contract"])
        self.assertIn("emotion or restraint", formatter["contract"])
        self.assertEqual(formatter["accepted_skeleton"]["scene_design"], self.spec["scene_design"])
        formatter_json = json.dumps(formatter, ensure_ascii=False)
        for secret in ("privateNPC_SENTINEL", "privateSourceID", "private_fragment", "source_refs", "branch_assumption"):
            self.assertNotIn(secret, formatter_json)
        projected_context = formatter["accepted_skeleton"]["scene_context"]
        self.assertEqual(projected_context["hero_position"], self.spec["scene_context"]["hero_position"]["value"])
        self.assertEqual(projected_context["hero_activity"], self.spec["scene_context"]["hero_activity"]["value"])
        self.assertEqual(projected_context["hero_initial_context"], [item["value"] for item in self.spec["scene_context"]["hero_initial_context"]])
        self.assertIn("Entry conditions only", projected_context["time_scope"])
        self.assertEqual(formatter["craft_input"], self.spec["craft_input"]["formatter"])
        self.assertEqual(formatter["accepted_skeleton"]["turns"][0]["hero_action"],
                         "Лея замечает холод в ладони; тревога сжимает живот, и она медленно касается знака, чтобы проверить его.")
        self.mutate("finish", status["revision"])

        next_spec = json.loads(json.dumps(self.spec, ensure_ascii=False))
        next_spec["branch_id"] = "branch_next"
        next_spec["story_time"] = dict(next_spec["story_time"], id="later", ordinal=2)
        self.call("start", session_id="branch_next", spec=next_spec, continue_from_session_id=self.session)
        continued_hero = self.call("packet", session_id="branch_next", role="hero")
        self.assertNotIn("reader-intent-unique-velvet", json.dumps(continued_hero, ensure_ascii=False))
        self.assertNotIn("scene_design", json.dumps(continued_hero, ensure_ascii=False))

    def test_optional_scene_design_validation_precedes_branch_write_and_mcp_schema_matches(self):
        for invalid in (None, {"atmosphere": " "}, {"unknown_control": "force a tragic ending"}):
            bad = json.loads(json.dumps(self.spec, ensure_ascii=False))
            bad["scene_design"] = invalid
            with self.assertRaises(rp.RoleplayError):
                self.call("start", spec=bad)
            self.assertFalse((self.project / ".talewisp/roleplay/branch_test.json").exists())

        mcp = PLUGIN / "scripts/talewisp_mcp.py"
        spec = importlib.util.spec_from_file_location("roleplay_mcp_scene_design_test", mcp)
        module = importlib.util.module_from_spec(spec)
        import sys
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        readiness_tool = next(tool for tool in module.TOOLS if tool["name"] == "talewisp_roleplay_readiness")
        design_schema = readiness_tool["inputSchema"]["properties"]["spec"]["properties"]["scene_design"]
        self.assertEqual(set(design_schema["properties"]), rp.SCENE_DESIGN_KEYS)
        self.assertFalse(design_schema["additionalProperties"])

    def test_scene_context_readiness_source_excerpts_and_role_projection(self):
        result = rp.readiness(self.project, self.vault, self.spec)
        self.assertTrue(result["scene_context_complete"])
        self.assertIn("source1#P0007", result["scene_context_source_coverage"]["hero_initial_context"])
        self.start()
        leader = self.call("packet", role="leader")
        hero = self.call("packet", role="hero")
        self.assertEqual(leader["scene_context"]["hero_activity"]["value"], "Лея изучает знак у двери.")
        self.assertIn("An NPC must have a plausible route", json.dumps(leader["scene_context"], ensure_ascii=False))
        self.assertTrue(any(self.lines["starting_state"] in item["text"] for item in leader["source_excerpts"]))
        self.assertEqual(hero["starting_context"]["hero_position"], "Лея стоит перед каменной дверью.")
        self.assertEqual(hero["starting_context"]["hero_activity"], "Лея изучает знак у двери.")
        self.assertEqual(hero["starting_context"]["hero_initial_context"], [self.lines["starting_state"]])
        hero_json = json.dumps(hero, ensure_ascii=False)
        self.assertNotIn("leader_only_context", hero_json)
        self.assertNotIn("plausible route", hero_json)
        self.assertNotIn("source_excerpts", hero_json)
        self.assertNotIn('"scene_contract"', hero_json)
        self.assertIn("not world facts", hero["craft_input_label"])
        self.assertEqual(hero["craft_input"], self.spec["craft_input"]["hero"])
        self.assertIn("not forever-current", hero["starting_context_rule"])
        self.assertIn("question", hero["contract"].casefold())
        mcp = PLUGIN / "scripts/talewisp_mcp.py"
        spec = importlib.util.spec_from_file_location("roleplay_mcp_context_schema_test", mcp)
        module = importlib.util.module_from_spec(spec)
        import sys
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        tool = next(tool for tool in module.TOOLS if tool["name"] == "talewisp_roleplay_readiness")
        properties = tool["inputSchema"]["properties"]["spec"]["properties"]
        self.assertEqual(set(properties["scene_context"]["properties"]), set(rp.SCENE_CONTEXT_REQUIRED))
        context_claim = properties["scene_context"]["properties"]["hero_position"]
        self.assertIn("branch_assumption", context_claim["properties"])
        self.assertNotIn("branch_assumption", properties["world"]["properties"]["rules"]["items"]["properties"])
        self.assertEqual(set(properties["craft_input"]["properties"]), set(rp.CRAFT_ROLES))

    def test_accepted_character_deltas_filter_role_context_by_persisted_target_index(self):
        self.start()
        path = self.project / ".talewisp/roleplay/branch_test.json"
        state = rp._load(path)
        self.assertEqual(state["fact_target_index"]["traits"], "hero.traits")
        self.assertEqual(state["fact_target_index"]["motives"], "hero.motives")
        self.assertEqual(state["fact_target_index"]["goals"], "hero.goals")
        state["accepted_character_deltas"] = {field: [] for field in ("traits", "motives", "goals")}
        for field in state["accepted_character_deltas"]:
            state["hero"][field] = []
        rp._save(path, state)
        packet = self.call("packet", role="hero")
        claims = {item.get("claim") for item in packet["role_context"] if item.get("fact_id")}
        self.assertFalse({self.lines[key] for key in ("traits", "motives", "goals")} & claims)
        self.assertIn(self.lines["knowledge"], claims)

    def test_v2_accepted_delta_without_target_index_fails_closed(self):
        self.start()
        path = self.project / ".talewisp/roleplay/branch_test.json"
        state = rp._load(path)
        state.pop("fact_target_index")
        state["accepted_character_deltas"] = {"traits": []}
        rp._save(path, state)
        with self.assertRaisesRegex(rp.RoleplayError, "lacks its fact target index"):
            self.call("packet", role="hero")

    def test_unknown_disposition_boundaries(self):
        unknowns = [{"id": "u1", "gap": "An unlocated route", "blocks_when": "If route matters"}]
        context = {"hero_position": {"value": "near the door"},
                   "hero_initial_context": [{"value": "holding a lantern"}]}
        runtime = {"unknown_dispositions": {"u1": {"status": "not_required", "reason": "This scene does not travel."}}}
        self.assertEqual(rp._unknown_disposition_errors(unknowns, runtime, context), [])
        runtime["unknown_dispositions"]["u1"] = {"status": "blocks_start"}
        self.assertTrue(any("blocks roleplay start" in e for e in rp._unknown_disposition_errors(unknowns, runtime, context)))
        runtime["unknown_dispositions"]["u1"] = {"status": "not_required"}
        self.assertTrue(any("concrete reason" in e for e in rp._unknown_disposition_errors(unknowns, runtime, context)))
        runtime["unknown_dispositions"]["u1"] = {"status": "resolved", "scene_context_refs": [{"field": "hero_initial_context", "index": 0}]}
        self.assertEqual(rp._unknown_disposition_errors(unknowns, runtime, context), [])
        for ref in ({"field": "hero_position", "index": 0}, {"field": "hero_initial_context", "index": True},
                    {"field": "hero_initial_context", "index": 1}, {"field": "scene", "index": 0}):
            with self.subTest(ref=ref):
                runtime["unknown_dispositions"]["u1"] = {"status": "resolved", "scene_context_refs": [ref]}
                self.assertTrue(rp._unknown_disposition_errors(unknowns, runtime, context))
        runtime["unknown_dispositions"] = {"u2": {"status": "not_required", "reason": "Not relevant."}}
        self.assertTrue(any("exactly the inventory unknown IDs" in e for e in rp._unknown_disposition_errors(unknowns, runtime, context)))

    def test_missing_scene_context_is_distinct_readiness_failure_and_start_block(self):
        incomplete = json.loads(json.dumps(self.spec, ensure_ascii=False))
        incomplete["scene_context"] = None
        self.attach_context_v2(incomplete)
        ready = rp.readiness(self.project, self.vault, incomplete)
        self.assertTrue(ready["declaration_complete"])
        self.assertFalse(ready["scene_context_complete"])
        self.assertFalse(ready["offerable"])
        self.assertTrue(any("scene_context" in issue for issue in ready["scene_context_issues"]))
        with self.assertRaisesRegex(rp.RoleplayError, "complete scene_context"):
            self.call("start", spec=incomplete)
        self.assertFalse((self.project / ".talewisp/roleplay/branch_test.json").exists())

    def test_branch_assumption_is_context_only_and_not_a_canon_provenance(self):
        bad = json.loads(json.dumps(self.spec, ensure_ascii=False))
        bad["world"]["rules"][0].pop("source_refs")
        bad["world"]["rules"][0]["branch_assumption"] = "Not a source declaration."
        self.assertTrue(rp.readiness(self.project, self.vault, bad)["offerable"])
        good = json.loads(json.dumps(self.spec, ensure_ascii=False))
        good["scene_context"]["hero_initial_context"].append({
            "value": "A branch-local test detail.", "branch_assumption": "Not a canon claim."})
        self.attach_context_v2(good)
        self.assertTrue(rp.readiness(self.project, self.vault, good)["scene_context_complete"])
        unknown = json.loads(json.dumps(self.spec, ensure_ascii=False))
        unknown["scene_context"]["leader_only_context"][0]["source_refs"] = [
            {"source_id": "unknown_source", "fragment_id": "unknown_fragment"}]
        self.attach_context_v2(unknown)
        readiness = rp.readiness(self.project, self.vault, unknown)
        self.assertFalse(readiness["scene_context_complete"])
        self.assertTrue(readiness["scene_context_issues"])

    def test_legacy_schema1_branch_defaults_missing_scene_design_without_rewrite(self):
        self.start()
        branch_path = self.project / ".talewisp/roleplay/branch_test.json"
        stored = json.loads(branch_path.read_text(encoding="utf-8"))
        stored.pop("scene_design")
        branch_path.write_text(json.dumps(stored, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        leader = self.call("packet", role="leader")
        self.assertEqual(leader["scene_design"], {})
        self.assertNotIn("scene_design", json.loads(branch_path.read_text(encoding="utf-8")))

    def test_legacy_schema1_branch_without_new_context_fields_remains_readable(self):
        self.start()
        branch_path = self.project / ".talewisp/roleplay/branch_test.json"
        stored = json.loads(branch_path.read_text(encoding="utf-8"))
        for field in ("source_excerpts", "craft_input", "current_hero_state",
                      "current_hero_state_status", "hero_state_history"):
            stored.pop(field)
        branch_path.write_text(json.dumps(stored, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        hero = self.call("packet", role="hero")
        leader = self.call("packet", role="leader")
        self.assertEqual(hero["starting_context"]["hero_position"], self.spec["scene_context"]["hero_position"]["value"])
        self.assertEqual(hero["starting_context"]["hero_activity"], self.spec["scene_context"]["hero_activity"]["value"])
        self.assertIsNone(hero["current_hero_state"])
        self.assertIn("unknown", hero["current_hero_state_scope"])
        self.assertEqual(hero["hero_state_history"], [])
        self.assertEqual(leader["source_excerpts"], [])
        self.assertEqual(leader["craft_input"], [])
        self.assertIn("scene_context", json.loads(branch_path.read_text(encoding="utf-8")))

    def test_current_hero_state_updates_are_revisioned_timed_and_never_stale(self):
        initial_context = json.loads(json.dumps(self.spec["request"]["runtime"]["scene_context"], ensure_ascii=False))
        self.start()
        initial = {"position": initial_context["hero_position"]["value"],
                   "activity": initial_context["hero_activity"]["value"]}
        hero = self.call("packet", role="hero")
        self.assertEqual(hero["current_hero_state"], initial)
        self.assertIn("current", hero["current_hero_state_scope"])
        self.assertNotIn("revision", json.dumps(hero["hero_state_history"], ensure_ascii=False))

        standing = {"position": "Пелун стоит у шнура, со стороны стоянки.",
                    "activity": "Пелун всматривается в гостя и продолжает разговор."}
        with self.assertRaisesRegex(rp.RoleplayError, "Stale roleplay revision"):
            self.call("set_hero_state", expected_revision=0, hero_state_updates=standing)
        status = self.call("set_hero_state", expected_revision=1, hero_state_updates=standing)
        self.assertEqual(status["phase"], "situation")  # State recording does not manufacture a turn.
        self.assertEqual(status["current_hero_state_status"], "resolved")
        self.assertEqual(self.call("packet", role="leader")["current_hero_state"], standing)
        stored = json.loads((self.project / ".talewisp/roleplay/branch_test.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["scene_context"], initial_context)  # Entry state is never rewritten.
        self.assertEqual(stored["readiness"]["sources"], [{key: source[key] for key in ("source_id", "path", "sha256")}
                                                            for source in self.spec["sources"]])
        with self.assertRaisesRegex(rp.RoleplayError, "exactly non-empty position and activity"):
            self.call("set_hero_state", expected_revision=2, hero_state_updates={"position": "Лея стоит."})

        status = self.call("situation", expected_revision=2, text="Гость отступает от шнура.",
                           revealed_to_hero=["Гость остаётся снаружи шнура."], hero_state_updates=standing)
        status = self.call("set_hero_state", expected_revision=status["revision"], hero_state_updates=standing)
        self.assertEqual(status["phase"], "hero_action")  # Explicit resolution leaves phase control intact.
        status = self.call("hero_action", expected_revision=status["revision"],
                           text="Пелун поднимается и осматривает место для ночлега.")
        stored = json.loads((self.project / ".talewisp/roleplay/branch_test.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["turns"][0]["hero_state_snapshot"], standing)
        self.assertEqual(stored["turns"][0]["character_state"]["traits"], stored["hero"]["traits"])
        hero = self.call("packet", role="hero")
        self.assertIsNone(hero["current_hero_state"])
        self.assertIn("unresolved", hero["current_hero_state_scope"])
        self.assertEqual(hero["hero_state_history"][-1]["last_resolved_state"], standing)
        self.assertNotIn("event", hero["hero_state_history"][-1])

        status = self.call("consequence", expected_revision=status["revision"], text="Пелун встаёт у шнура.")
        self.assertEqual(status["current_hero_state_status"], "unresolved")
        resolved = {"position": "Пелун стоит у палатки, внутри шнура.",
                    "activity": "Пелун присматривает место, где гость сможет ночевать снаружи."}
        status = self.call("situation", expected_revision=status["revision"], text="Остаётся дождь.",
                           revealed_to_hero=["Дождь продолжается."], hero_state_updates=resolved)
        self.assertEqual(self.call("packet", role="hero")["current_hero_state"], resolved)
        status = self.call("hero_action", expected_revision=status["revision"], text="Пелун остаётся у палатки.")
        status = self.call("consequence", expected_revision=status["revision"], text="Палатка остаётся закрыта.",
                           hero_state_updates=resolved)
        status = self.call("accept_skeleton", expected_revision=status["revision"], accepted=True)
        formatter = self.call("packet", role="formatter", voice_input={"voice": "selected"})
        skeleton = formatter["accepted_skeleton"]
        self.assertEqual(skeleton["turns"][0]["hero_state_snapshot"], standing)
        self.assertEqual(skeleton["turns"][1]["hero_state_snapshot"], resolved)
        self.assertTrue(any(item["turn"] == 2 and item["phase"] == "situation" and item["position"] == resolved["position"]
                            for item in skeleton["hero_state_history"]))
        status = self.call("set_hero_state", expected_revision=status["revision"], hero_state_updates=resolved)
        self.assertFalse(status["formatting_ready"])
        with self.assertRaisesRegex(rp.RoleplayError, "accepted current skeleton"):
            self.call("packet", role="formatter", voice_input={"voice": "selected"})


if __name__ == "__main__":
    unittest.main()

