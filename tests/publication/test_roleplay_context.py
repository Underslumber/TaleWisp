import importlib.util
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = Path(os.environ.get('TALEWISP_TEST_PLUGIN_ROOT', ROOT / 'plugin'))


SCRIPT = PLUGIN / "scripts/roleplay_context.py"
SPEC = importlib.util.spec_from_file_location("roleplay_context_test", SCRIPT)
ctx = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ctx)


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.root = Path(self.temp.name)
        self.vault = self.root / "vault"
        self.project = self.root / "project"
        self.vault.mkdir()
        self.project.mkdir()
        (self.vault / "source.md").write_text("P0001 Первый факт.\nПродолжение единицы.\n\nP0002 Второй факт.\n", encoding="utf-8")
        self.request = {"context_version": 2, "assembly_run_id": "assembly1", "allow_roleplay": False,
                        "author_constraints": [{"id": f"c{i}", "text": f"Literal correction {i}"} for i in range(1, 7)],
                        "read_scope": [{"source_id": "b08", "path": "source.md", "first_id": "P0001", "last_id": "P0002"}]}
        self.prepared = ctx.prepare_context(self.vault, self.request)
        self.inventory = self.make_inventory()

    def tearDown(self):
        self.temp.cleanup()

    def make_inventory(self):
        facts = [{"id": "f1", "claim": "First fact", "status": "active",
                  "evidence": [{"source_id": "b08", "unit_id": "P0001", "quote": "Первый факт"}],
                  "author_constraint_ids": [f"c{i}" for i in range(1, 7)], "known_to": ["leader"],
                  "required_roles": ["leader"], "scene_influence": "Affects approach.",
                  "isolation": True}]
        inv = {"context_version": 2, "request": self.request, "facts": facts,
               "unit_coverage": [{"source_id": "b08", "unit_id": u["unit_id"], "fact_ids": ["f1"], "excluded_parts": []}
                                 for u in self.prepared["source_packet"]["sources"][0]["units"]],
               "conflicts": [], "unknowns": []}
        inv["role_packets"] = ctx.build_role_packets(inv)
        return inv

    def receipt(self, inv=None):
        inv = inv or self.inventory
        packets = ctx.build_role_packets(inv)
        hashes = [ctx.canonical_sha256(x) for x in (self.request, self.prepared["source_packet"], inv, packets)]
        return {"schema_version": 1, "run_id": "independent1", "identity": "reviewer",
                "provenance": "trusted_host_review", "request_sha256": hashes[0],
                "source_packet_sha256": hashes[1], "inventory_sha256": hashes[2],
                "role_packets_sha256": hashes[3], "findings": [], "blockers": []}

    def test_prepare_reads_full_units_and_expected_coverage(self):
        units = self.prepared["source_packet"]["sources"][0]["units"]
        self.assertEqual([u["unit_id"] for u in units], ["P0001", "P0002"])
        self.assertIn("Продолжение единицы", units[0]["text"])
        self.assertEqual(len(self.prepared["expected_unit_ids"]), 2)

    def test_missing_any_literal_constraint_fails(self):
        self.inventory["facts"][0]["author_constraint_ids"].pop()
        self.inventory["role_packets"] = ctx.build_role_packets(self.inventory)
        with self.assertRaisesRegex(ctx.ContextError, "Every literal author constraint"):
            ctx.validate_inventory(self.request, self.prepared["source_packet"], self.inventory, None)

    def test_missing_source_unit_coverage_fails(self):
        self.inventory["unit_coverage"].pop()
        with self.assertRaisesRegex(ctx.ContextError, "Every source unit"):
            ctx.validate_inventory(self.request, self.prepared["source_packet"], self.inventory, None)

    def test_inline_or_stale_audit_never_passes(self):
        audit = self.receipt()
        self.assertFalse(ctx.validate_inventory(self.request, self.prepared["source_packet"], self.inventory, audit, trusted_receipt=False)["semantic_audit_current"])
        audit["inventory_sha256"] = "0" * 64
        self.assertFalse(ctx.validate_inventory(self.request, self.prepared["source_packet"], self.inventory, audit, trusted_receipt=True)["semantic_audit_current"])

    def test_persisted_receipt_and_allow_roleplay_gate(self):
        audit_dir = self.project / ".talewisp/context-audits"
        audit_dir.mkdir(parents=True)
        (audit_dir / "audit1.json").write_text(json.dumps(self.receipt()), encoding="utf-8")
        result = ctx.check_context(self.vault, self.request, self.inventory, {"receipt_id": "audit1"}, self.project)
        self.assertTrue(result["analysis_ready"])
        self.assertFalse(result["offerable"])
        self.assertEqual(result["expected_unit_ids"], ["b08#P0001", "b08#P0002"])

    def staged_fixture(self):
        action = "Marcus, answer this; if you refuse, I will leave."
        bundle = {"role_memory": {"hero": {"private_memory": ["hero private fact"]}, "leader": {"heard_dialogue": [{"speaker": "Bast", "recipient": "Marcus", "text": "The room is not empty."}], "npc_memories": {
            "Marcus": {"experience": ["He owes the guard a report."], "private_memory": ["The seal is compromised."]},
            "Bast": {"experience": ["He heard the exchange."]}}}},
            "turn_intake": {"hero_action": action, "units": [
                {"id": "q1", "start": 0, "end": 29, "text": action[:29], "kind": "question", "disposition": "ready", "rationale": "Direct question", "gap_ids": [], "addressed_to": ["Marcus"]},
                {"id": "c1", "start": 29, "end": len(action), "text": action[29:], "kind": "condition", "disposition": "ready", "rationale": "Stated condition", "gap_ids": [], "addressed_to": ["Marcus"]}]},
            "physical_staging": {"Marcus": "at the table", "Bast": "by the door"},
            "relationship_samples": ["Marcus distrusts the guard"]}
        reqs = [{"id": "answer", "npc": "Marcus", "question": "What does he do with the question?", "unit_ids": ["q1"], "public_dialogue_refs": ["/heard_dialogue/0"]},
                {"id": "condition", "npc": "Marcus", "question": "What does the condition change?", "unit_ids": ["c1"]}]
        state = ctx.initialize_staged_turn(bundle, action, reqs)
        return state, bundle

    def staged_response(self, state):
        return {"npc": "Marcus", "action_sha256": state["action_sha256"], "source_facts_sha256": state["source_facts_sha256"], "facets": [
            {"id": "answer", "status": "addressed", "public_events": [{"kind": "utterance", "recipient": "the hero", "text": "Which report do you mean?"}], "knowledge_refs": [{"kind": "memory", "id": "/experience/0"}], "basis": "His duty requires a precise report."},
            {"id": "condition", "status": "condition", "public_events": [{"kind": "utterance", "recipient": "the hero", "text": "I will keep the report closed until you clarify."}], "knowledge_refs": [{"kind": "public_unit", "id": "c1"}], "basis": "The stated departure would leave the report unresolved."}]}

    def make_assembled_scene(self, state, bundle):
        render = ctx.build_render_input(state, bundle)
        slots = [part for part in render["frozen_segments"] if part.get("segment_kind") == "utterance_slot"]
        framing = [{"slot_id": slot["slot_id"], "before": "Баст поставил ладонь на стол.", "after": "Маркус не отвёл взгляда."} for slot in slots]
        return ctx.record_staged_framing(state, bundle, framing)

    def test_staged_projection_is_owner_scoped_and_renderer_gets_frozen_utterance_slots(self):
        state, bundle = self.staged_fixture()
        payload = ctx.build_npc_resolution_input(state, bundle, "Marcus")
        self.assertEqual(payload["own_memory"]["experience"], ["He owes the guard a report."])
        self.assertNotIn("He heard the exchange", json.dumps(payload))
        self.assertNotIn("hero private fact", json.dumps(payload))
        self.assertEqual(payload["perceived_public_action"][0]["text"], state["hero_action"][:29])
        self.assertEqual(payload["perceived_public_dialogue"][0]["text"], "The room is not empty.")
        ctx.validate_npc_resolution(state, bundle, "Marcus", self.staged_response(state))
        candidate = state["candidate_resolutions"]["Marcus"]
        with self.assertRaisesRegex(ctx.ContextError, "every current NPC resolution"):
            ctx.build_render_input(state, bundle)
        ctx.accept_npc_resolution(state, "Marcus", {"accepted": True, "candidate_sha256": candidate["sha256"], "findings": []})
        render = ctx.build_render_input(state, bundle)
        self.assertEqual(render["frozen_segments"][0], {"kind": "hero_action", "text": state["hero_action"]})
        self.assertEqual(render["frozen_segments"][1]["text"], "Which report do you mean?")
        self.assertIn("framing", render["instruction"])
        self.assertNotIn("public_semantic_acts", render)
        self.assertNotIn("knowledge_refs", json.dumps(render))
        self.assertNotIn("facet_id", json.dumps(render))
        self.assertNotIn("private_memory", json.dumps(render))

    def test_staged_facets_owner_and_turn_binding_are_mandatory(self):
        state, bundle = self.staged_fixture()
        response = self.staged_response(state)
        response["facets"].pop()
        with self.assertRaisesRegex(ctx.ContextError, "every assigned facet"):
            ctx.validate_npc_resolution(state, bundle, "Marcus", response)
        response = self.staged_response(state)
        response["facets"][0]["knowledge_refs"] = [{"kind": "memory", "id": "/hero_private_memory/0"}]
        with self.assertRaisesRegex(ctx.ContextError, "outside this NPC's memory"):
            ctx.validate_npc_resolution(state, bundle, "Marcus", response)
        response = self.staged_response(state)
        response["action_sha256"] = "stale"
        with self.assertRaisesRegex(ctx.ContextError, "owner or action binding"):
            ctx.validate_npc_resolution(state, bundle, "Marcus", response)

    def test_addressed_facet_requires_actual_event_payload_without_lexical_will_ban(self):
        state, bundle = self.staged_fixture()
        response = self.staged_response(state)
        response["facets"][0]["public_events"] = []
        with self.assertRaisesRegex(ctx.ContextError, "at least one concrete public event"):
            ctx.validate_npc_resolution(state, bundle, "Marcus", response)
        response = self.staged_response(state)
        self.assertIn("I will keep the report closed", response["facets"][1]["public_events"][0]["text"])
        ctx.validate_npc_resolution(state, bundle, "Marcus", response)

    def test_host_can_reject_promise_only_candidate_after_structural_validation(self):
        state, bundle = self.staged_fixture()
        response = self.staged_response(state)
        response["facets"][0]["public_events"][0]["text"] = "I will explain the report later."
        ctx.validate_npc_resolution(state, bundle, "Marcus", response)
        candidate = state["candidate_resolutions"]["Marcus"]
        rejected = ctx.accept_npc_resolution(state, "Marcus", {
            "accepted": False,
            "candidate_sha256": candidate["sha256"],
            "findings": [{"facet": "answer", "quoted_text": "I will explain the report later.",
                          "reason": "This promises a later answer but contains no report content."}],
        })
        self.assertFalse(rejected["accepted"])
        with self.assertRaisesRegex(ctx.ContextError, "every current NPC resolution"):
            ctx.build_render_input(state, bundle)

    def test_staged_requirements_cover_material_units_and_exclude_self_private_units(self):
        state, bundle = self.staged_fixture()
        incomplete = [{"id": "answer", "npc": "Marcus", "question": "Answer?", "unit_ids": ["q1"]}]
        with self.assertRaisesRegex(ctx.ContextError, "Every material question/condition unit.*c1"):
            ctx.initialize_staged_turn(bundle, state["hero_action"], incomplete)

        action = state["hero_action"] + " I think privately."
        start = len(state["hero_action"])
        bundle["turn_intake"]["hero_action"] = action
        bundle["turn_intake"]["units"].append({"id": "self1", "start": start, "end": len(action),
            "text": action[start:], "kind": "statement", "disposition": "ready", "rationale": "Private thought", "gap_ids": [], "addressed_to": ["self"]})
        good = ctx.initialize_staged_turn(bundle, action, state["requirements"])
        self.assertEqual(good["phase"], "pending_resolutions")
        selected_private = [dict(state["requirements"][0], unit_ids=["q1", "self1"]), state["requirements"][1]]
        with self.assertRaisesRegex(ctx.ContextError, "self-private unit"):
            ctx.initialize_staged_turn(bundle, action, selected_private)

    def test_npc_cannot_cite_unperceived_self_private_turn_unit(self):
        state, bundle = self.staged_fixture()
        units = bundle["turn_intake"]["units"]
        units[1]["addressed_to"] = ["self"]
        only_question = [{"id": "answer", "npc": "Marcus", "question": "Answer?", "unit_ids": ["q1"]}]
        state = ctx.initialize_staged_turn(bundle, state["hero_action"], only_question)
        response = {"npc": "Marcus", "action_sha256": state["action_sha256"],
                    "source_facts_sha256": state["source_facts_sha256"], "facets":[
            {"id": "answer", "status": "addressed", "public_events": [{"kind": "utterance", "recipient": "the hero", "text": "Which report?"}],
             "knowledge_refs": [{"kind": "public_unit", "id": "c1"}], "basis": "A private thought."}]}
        with self.assertRaisesRegex(ctx.ContextError, "not explicitly perceived by this NPC"):
            ctx.validate_npc_resolution(state, bundle, "Marcus", response)

    def test_source_gap_is_typed_and_still_requires_host_acceptance(self):
        state, bundle = self.staged_fixture()
        response = self.staged_response(state)
        response["facets"][0].update(status="source_gap", public_events=[], knowledge_refs=[],
                                     basis="The source does not establish ignorance.")
        ctx.validate_npc_resolution(state, bundle, "Marcus", response)
        with self.assertRaisesRegex(ctx.ContextError, "every current NPC resolution"):
            ctx.build_render_input(state, bundle)

    def test_staged_source_facts_are_bound_and_rejection_closes_resolution(self):
        state, bundle = self.staged_fixture()
        bundle["role_memory"]["leader"]["npc_memories"]["Marcus"]["experience"].append("new fact")
        with self.assertRaisesRegex(ctx.ContextError, "source facts changed"):
            ctx.build_npc_resolution_input(state, bundle, "Marcus")
        state, bundle = self.staged_fixture()
        ctx.validate_npc_resolution(state, bundle, "Marcus", self.staged_response(state))
        cand = state["candidate_resolutions"]["Marcus"]
        ctx.accept_npc_resolution(state, "Marcus", {"accepted": False, "candidate_sha256": cand["sha256"], "findings": ["Does not account for condition"]})
        with self.assertRaisesRegex(ctx.ContextError, "current pending turn"):
            ctx.build_npc_resolution_input(state, bundle, "Marcus")
        with self.assertRaisesRegex(ctx.ContextError, "every current NPC resolution"):
            ctx.build_render_input(state, bundle)

    def test_staged_rejection_or_missing_scene_acceptance_blocks_commit(self):
        state, bundle = self.staged_fixture()
        ctx.validate_npc_resolution(state, bundle, "Marcus", self.staged_response(state))
        cand = state["candidate_resolutions"]["Marcus"]
        rejected = ctx.accept_npc_resolution(state, "Marcus", {"accepted": False, "candidate_sha256": cand["sha256"], "findings": ["Does not answer"]})
        self.assertFalse(rejected["accepted"])
        with self.assertRaisesRegex(ctx.ContextError, "accepted literal scene"):
            ctx.commit_staged_turn(state, bundle)
        state, bundle = self.staged_fixture()
        ctx.validate_npc_resolution(state, bundle, "Marcus", self.staged_response(state))
        cand = state["candidate_resolutions"]["Marcus"]
        ctx.accept_npc_resolution(state, "Marcus", {"accepted": True, "candidate_sha256": cand["sha256"], "findings": []})
        with self.assertRaisesRegex(ctx.ContextError, "Host scene review must bind"):
            ctx.accept_staged_scene(state, bundle, "A scene", {})
        scene = self.make_assembled_scene(state, bundle)
        digest = ctx.canonical_sha256(scene)
        rejected_scene = ctx.accept_staged_scene(state, bundle, scene, {"accepted": False, "scene_sha256": digest, "findings": ["Wrong physical transition"]})
        self.assertFalse(rejected_scene["accepted"])
        with self.assertRaisesRegex(ctx.ContextError, "accepted literal scene"):
            ctx.commit_staged_turn(state, bundle)

    def test_next_hero_input_requires_committed_scene(self):
        state, bundle = self.staged_fixture()
        with self.assertRaisesRegex(ctx.ContextError, "requires the prior accepted scene"):
            ctx.build_next_hero_input(state, bundle, "hero")
        ctx.validate_npc_resolution(state, bundle, "Marcus", self.staged_response(state))
        cand = state["candidate_resolutions"]["Marcus"]
        ctx.accept_npc_resolution(state, "Marcus", {"accepted": True, "candidate_sha256": cand["sha256"], "findings": []})
        scene = self.make_assembled_scene(state, bundle)
        ctx.accept_staged_scene(state, bundle, scene, {"accepted": True, "scene_sha256": ctx.canonical_sha256(scene), "findings": []})
        ctx.commit_staged_turn(state, bundle)
        hero = ctx.build_next_hero_input(state, bundle, "hero")
        self.assertEqual(hero["accepted_scene"], scene)

    def test_scene_assembly_preserves_exact_hero_and_npc_content_and_rejects_tampering(self):
        state, bundle = self.staged_fixture()
        action = state["hero_action"]
        ctx.validate_npc_resolution(state, bundle, "Marcus", self.staged_response(state))
        candidate = state["candidate_resolutions"]["Marcus"]
        ctx.accept_npc_resolution(state, "Marcus", {"accepted": True, "candidate_sha256": candidate["sha256"], "findings": []})
        render = ctx.build_render_input(state, bundle)
        slots = [part for part in render["frozen_segments"] if part.get("segment_kind") == "utterance_slot"]
        framing = [{"slot_id": slot["slot_id"], "before": "Bast put a palm on the table.", "after": "Marcus held his gaze."} for slot in slots]
        scene = ctx.record_staged_framing(state, bundle, framing)
        self.assertTrue(scene.startswith(action))
        self.assertEqual(scene[:len(action)], action)
        self.assertIn("leave.\n\nBast put a palm on the table.\n\nMarcus:", scene)
        self.assertIn("?\n\nMarcus held his gaze.\n\nBast put a palm on the table.\n\nMarcus:", scene)
        for slot in slots:
            self.assertIn(slot["text"], scene)
        digest = ctx.canonical_sha256(scene)
        review = {"accepted": True, "scene_sha256": digest, "findings": []}
        tampered_hero = scene.replace(action, action + " altered", 1)
        with self.assertRaisesRegex(ctx.ContextError, "exact hero action and frozen NPC utterances"):
            ctx.accept_staged_scene(state, bundle, tampered_hero, {"accepted": True, "scene_sha256": ctx.canonical_sha256(tampered_hero), "findings": []})
        tampered_npc = scene.replace("Which report do you mean?", "I'll explain later.")
        with self.assertRaisesRegex(ctx.ContextError, "exact hero action and frozen NPC utterances"):
            ctx.accept_staged_scene(state, bundle, tampered_npc, {"accepted": True, "scene_sha256": ctx.canonical_sha256(tampered_npc), "findings": []})
        ctx.accept_staged_scene(state, bundle, scene, review)

    def test_render_slot_ids_are_unambiguous_across_npc_and_facet_names(self):
        state, bundle = self.staged_fixture()
        memories = bundle["role_memory"]["leader"]["npc_memories"]
        memories["A"] = {"experience": ["First fact."]}
        memories["A-B"] = {"experience": ["Second fact."]}
        requirements = [
            {"id": "B-C", "npc": "A", "question": "First question?", "unit_ids": ["q1"]},
            {"id": "C", "npc": "A-B", "question": "Second question?", "unit_ids": ["c1"]},
        ]
        state = ctx.initialize_staged_turn(bundle, state["hero_action"], requirements)
        for npc, facet_id, text in (("A", "B-C", "First actual answer."),
                                    ("A-B", "C", "Second actual answer.")):
            response = {"npc": npc, "action_sha256": state["action_sha256"],
                        "source_facts_sha256": state["source_facts_sha256"],
                        "facets": [{"id": facet_id, "status": "addressed",
                                    "public_events": [{"kind": "utterance", "recipient": "the hero", "text": text}],
                                    "knowledge_refs": [{"kind": "memory", "id": "/experience/0"}],
                                    "basis": "The cited fact supports this answer."}]}
            ctx.validate_npc_resolution(state, bundle, npc, response)
            candidate = state["candidate_resolutions"][npc]
            ctx.accept_npc_resolution(state, npc, {"accepted": True,
                "candidate_sha256": candidate["sha256"], "findings": []})
        render = ctx.build_render_input(state, bundle)
        slots = [part for part in render["frozen_segments"] if part.get("segment_kind") == "utterance_slot"]
        self.assertEqual(len(slots), 2)
        self.assertNotEqual(slots[0]["slot_id"], slots[1]["slot_id"])
        self.assertEqual({slot["npc"] for slot in slots}, {"A", "A-B"})
        framing = [{"slot_id": slot["slot_id"], "before": "", "after": ""} for slot in slots]
        scene = ctx.record_staged_framing(state, bundle, framing)
        self.assertIn("First actual answer.", scene)
        self.assertIn("Second actual answer.", scene)

    def test_scene_acceptance_rechecks_resolution_receipts_and_current_bundle(self):
        state, bundle = self.staged_fixture()
        ctx.validate_npc_resolution(state, bundle, "Marcus", self.staged_response(state))
        candidate = state["candidate_resolutions"]["Marcus"]
        ctx.accept_npc_resolution(state, "Marcus", {"accepted": True, "candidate_sha256": candidate["sha256"], "findings": []})
        ctx.build_render_input(state, bundle)
        scene = self.make_assembled_scene(state, bundle)
        review = {"accepted": True, "scene_sha256": ctx.canonical_sha256(scene), "findings": []}
        bundle["physical_staging"]["Marcus"] = "at the door"
        with self.assertRaisesRegex(ctx.ContextError, "Current source facts or staging"):
            ctx.accept_staged_scene(state, bundle, scene, review)

        state, bundle = self.staged_fixture()
        ctx.validate_npc_resolution(state, bundle, "Marcus", self.staged_response(state))
        candidate = state["candidate_resolutions"]["Marcus"]
        ctx.accept_npc_resolution(state, "Marcus", {"accepted": True, "candidate_sha256": candidate["sha256"], "findings": []})
        ctx.build_render_input(state, bundle)
        state["candidate_resolutions"]["Marcus"]["value"]["facets"][0]["public_events"][0]["text"] = "Mutated after acceptance."
        with self.assertRaisesRegex(ctx.ContextError, "candidate is missing or changed"):
            ctx.accept_staged_scene(state, bundle, scene, review)

    def test_legacy_actor_input_remains_deep_copied(self):
        bundle = {"role_memory": {"leader": {"situation": "At the table.", "npc_memories": {"Marcus": {"experience": ["Duty."]}}}}}
        payload = ctx.build_actor_input(bundle, "leader", "legacy")
        payload["memory"]["npc_memories"]["Marcus"]["experience"].append("mutated")
        self.assertEqual(bundle["role_memory"]["leader"]["npc_memories"]["Marcus"]["experience"], ["Duty."])

    def test_role_projection_does_not_leak_leader_only_fact(self):
        hero = ctx.build_role_packets(self.inventory)["hero"]
        self.assertFalse(any(p.get("fact_id") == "f1" for p in hero))

    def test_actor_projection_excludes_host_audit_and_source_inventory(self):
        quote = {"speaker": "Bast", "recipient": "Marcus", "text": "Хватит юродствовать.", "manner": "сухо"}
        bundle = {"role_memory": {"hero": {"situation": "At the gate.", "heard_dialogue": [quote]}},
                  "host_audit": {"provenance": "reviewed", "validation": {"ready": True}},
                  "source_inventory": [{"id": "P0057", "quote": quote["text"]}]}
        payload = ctx.build_actor_input(bundle, "hero", {"turn": 2})
        self.assertEqual(set(payload), {"role", "contract", "memory"})
        self.assertEqual(payload["memory"]["heard_dialogue"][0], quote)
        self.assertNotIn("host_audit", payload)
        self.assertNotIn("source_inventory", payload)

    def test_actor_projection_rejects_nested_audit_fields_in_private_memory(self):
        bundle = {"role_memory": {"leader": {"situation": "Briefing.",
                  "npc_memories": {"Marcus": {"observations": ["He smiled."],
                  "source_ids": ["P0045"]}}}}}
        with self.assertRaisesRegex(ctx.ContextError, "Unknown leader memory.npc_memories.Marcus fields"):
            ctx.build_actor_input(bundle, "leader", "contract")

    def test_actor_projection_preserves_literal_dialogue_and_separates_hero_private_memory(self):
        line = {"speaker": "Beal", "recipient": "Bast", "text": "Я готов!", "manner": "торопливо"}
        bundle = {"role_memory": {"leader": {"heard_dialogue": [line],
                  "hero_private_memory": ["Беал боится опоздать."],
                  "npc_memories": {"Bast": {"private_memory": ["Не выдавать это Маркусу."]}}}}}
        payload = ctx.build_actor_input(bundle, "leader", "leader contract")
        self.assertEqual(payload["memory"]["heard_dialogue"][0], line)
        self.assertEqual(payload["memory"]["hero_private_memory"], ["Беал боится опоздать."])
        self.assertNotIn("hero_private_memory", payload["memory"]["npc_memories"]["Bast"])

    def test_actor_projection_returns_deep_copies(self):
        quote = {"speaker": "Bast", "recipient": "Beal", "text": "Пойдём."}
        bundle = {"role_memory": {"hero": {"heard_dialogue": [quote]}}}
        contract = {"limits": ["two exchanges"]}
        craft = {"examples": ["keep the voice"]}
        payload = ctx.build_actor_input(bundle, "hero", contract, craft)
        payload["memory"]["heard_dialogue"][0]["text"] = "changed"
        payload["contract"]["limits"].append("changed")
        payload["craft_input"]["examples"].clear()
        self.assertEqual(bundle["role_memory"]["hero"]["heard_dialogue"][0]["text"], "Пойдём.")
        self.assertEqual(contract["limits"], ["two exchanges"])
        self.assertEqual(craft["examples"], ["keep the voice"])

    def test_unresolved_context_gap_blocks_both_actor_roles(self):
        bundle = {"role_memory": {"hero": {"situation": "At the gate."},
                                  "leader": {"situation": "Briefing."}},
                  "context_gaps": [{"id": "assignment", "question": "What was already requested?",
                                    "status": "unresolved"}]}
        for role in ("hero", "leader"):
            with self.subTest(role=role), self.assertRaisesRegex(ctx.ContextError, "Unresolved context gaps"):
                ctx.build_actor_input(bundle, role, "contract")

    def test_context_gap_rejects_invalid_status(self):
        bundle = {"role_memory": {"hero": {"situation": "At the gate."}},
                  "context_gaps": [{"id": "g1", "question": "What happened?", "status": "pending"}]}
        with self.assertRaisesRegex(ctx.ContextError, "invalid status"):
            ctx.build_actor_input(bundle, "hero", "contract")

    def test_context_gap_rejects_dangling_role_memory_binding(self):
        bundle = {"role_memory": {"hero": {"private_memory": ["Маркус уже попросил выбрать грань Игнорирование."]}},
                  "context_gaps": [{"id": "g1", "question": "Что уже просил Маркус?",
                                    "status": "source_resolved", "fact": "Маркус уже попросил выбрать грань Игнорирование.",
                                    "rationale": "Это объясняет уже известную герою цель.", "evidence": "source.md#C016P0027",
                                    "bindings": [{"role": "hero", "memory_path": "/private_memory/4"}]}]}
        with self.assertRaisesRegex(ctx.ContextError, "dangling role-memory binding"):
            ctx.build_actor_input(bundle, "hero", "contract")

    def test_branch_context_gap_requires_explicit_noncanon_authorization(self):
        fact = "Маркус отложил подробности до встречи в гильдии."
        bundle = {"role_memory": {"leader": {"npc_memories": {"Marcus": {"private_memory": [fact]}}}},
                  "context_gaps": [{"id": "g1", "question": "Почему он не раскрыл подробности?",
                                    "status": "branch_resolved", "fact": fact,
                                    "rationale": "Временная постановка для одной пробы.",
                                    "bindings": [{"role": "leader", "memory_path": "/npc_memories/Marcus/private_memory/0"}]}]}
        with self.assertRaisesRegex(ctx.ContextError, "explicit noncanon staging authorization"):
            ctx.build_actor_input(bundle, "leader", "contract")

    def test_source_resolved_context_gap_projects_memory_without_audit_export(self):
        fact = "Маркус уже попросил выбрать грань Игнорирование."
        bundle = {"role_memory": {"hero": {"private_memory": [fact]},
                                  "leader": {"npc_memories": {"Marcus": {"private_memory": [fact]}}}},
                  "context_gaps": [{"id": "assignment", "question": "Какова уже высказанная цель Маркуса?",
                                    "status": "source_resolved", "fact": fact,
                                    "rationale": "Факт описывает его уже высказанное поручение, не будущую подготовку.",
                                    "evidence": "books/series.md#C016P0027",
                                    "bindings": [{"role": "hero", "memory_path": "/private_memory/0"},
                                                 {"role": "leader", "memory_path": "/npc_memories/Marcus/private_memory/0"}]}]}
        payload = ctx.build_actor_input(bundle, "hero", "contract")
        self.assertEqual(payload["memory"]["private_memory"], [fact])
        self.assertNotIn("context_gaps", payload)
        self.assertNotIn("evidence", json.dumps(payload, ensure_ascii=False))

    def test_context_gap_actor_projection_remains_a_deep_copy(self):
        fact = "Баст уже предупредила его об опасности."
        bundle = {"role_memory": {"hero": {"private_memory": [fact]}},
                  "context_gaps": [{"id": "g1", "question": "Что сказала Баст?", "status": "source_resolved",
                                    "fact": fact, "rationale": "Это уже было услышано.", "evidence": "notes.md#P8",
                                    "bindings": [{"role": "hero", "memory_path": "/private_memory/0"}]}]}
        payload = ctx.build_actor_input(bundle, "hero", "contract")
        payload["memory"]["private_memory"][0] = "changed"
        self.assertEqual(bundle["role_memory"]["hero"]["private_memory"][0], fact)
        self.assertEqual(bundle["context_gaps"][0]["fact"], fact)

    def test_context_gap_resolution_must_bind_exact_literal_fact(self):
        bundle = {"role_memory": {"hero": {"private_memory": ["Маркус поставил срок до месяца."]}},
                  "context_gaps": [{"id": "g1", "question": "Какой срок?", "status": "source_resolved",
                                    "fact": "Маркус попросил ответить за месяц.", "rationale": "Та же мысль.",
                                    "evidence": "source.md#P1",
                                    "bindings": [{"role": "hero", "memory_path": "/private_memory/0"}]}]}
        with self.assertRaisesRegex(ctx.ContextError, "exact literal positive fact"):
            ctx.build_actor_input(bundle, "hero", "contract")

    def test_actor_projection_enforces_role_boundaries_and_rejects_unknown_roles(self):
        hero_bundle = {"role_memory": {"hero": {"private_memory": ["my thought"]}}}
        with self.assertRaisesRegex(ctx.ContextError, "Unknown actor role"):
            ctx.build_actor_input(hero_bundle, "formatter", "contract")
        leader_memory = {"situation": "Briefing.", "npc_memories": {"Bast": {"observations": ["She nodded."]}}}
        with self.assertRaisesRegex(ctx.ContextError, "Unknown hero memory fields"):
            ctx.build_actor_input({"role_memory": {"hero": leader_memory}}, "hero", "contract")

    def test_active_hero_targets_require_both_audience_and_role_projection(self):
        for target in ("hero.traits", "hero.motives", "hero.goals", "hero.knowledge"):
            for known_to, required_roles in ((["leader"], ["leader"]), (["hero"], ["leader"])):
                with self.subTest(target=target, known_to=known_to, required_roles=required_roles):
                    fact = {"id": "candidate", "target": target, "status": "active",
                            "known_to": known_to, "required_roles": required_roles}
                    with self.assertRaisesRegex(ctx.ContextError, "requires hero in known_to and required_roles"):
                        ctx.resolve_fact_target(fact)
                    inventory = json.loads(json.dumps(self.inventory, ensure_ascii=False))
                    inventory["facts"][0]["target"] = target
                    inventory["facts"][0]["known_to"] = known_to
                    inventory["facts"][0]["required_roles"] = required_roles
                    inventory["role_packets"] = ctx.build_role_packets(inventory)
                    with self.assertRaisesRegex(ctx.ContextError, "requires hero in known_to and required_roles"):
                        ctx.validate_inventory(self.request, self.prepared["source_packet"], inventory, None)
        self.assertEqual(ctx.resolve_fact_target({"id": "default", "status": "active",
                                                    "known_to": ["hero"], "required_roles": ["hero"]}),
                         "hero.knowledge")
        self.assertEqual(ctx.resolve_fact_target({"id": "leader", "status": "active",
                                                    "known_to": ["hero"], "required_roles": ["leader"]}),
                         "world.rules")

    def test_symlink_source_is_rejected(self):
        outside = self.root / "outside.md"
        outside.write_text("P0001 x\nP0002 y\n", encoding="utf-8")
        link = self.vault / "link.md"
        try:
            link.symlink_to(outside)
        except OSError as exc:
            self.skipTest(f"symlink creation unavailable: {exc}")
        request = dict(self.request)
        request["read_scope"] = [{**self.request["read_scope"][0], "path": "link.md"}]
        with self.assertRaisesRegex(ctx.ContextError, "symlink"):
            ctx.prepare_context(self.vault, request)

    def turn_bundle(self, action="Ask Bast for terms; decide after review."):
        split = action.index(";") + 1
        bundle = {
            "role_memory": {"leader": {"situation": "At the hearth.",
                          "npc_memories": {"Bast": {"observations": ["She listens."]}}}},
            "turn_intake": {"hero_action": action, "units": [
                {"id": "u1", "start": 0, "end": split, "text": action[:split],
                 "kind": "question", "disposition": "ready", "rationale": "Direct request.",
                 "gap_ids": [], "addressed_to": ["Bast"]},
                {"id": "u2", "start": split, "end": len(action), "text": action[split:],
                 "kind": "condition", "disposition": "ready", "rationale": "Decision condition.",
                 "gap_ids": [], "addressed_to": []}]}}
        return bundle

    def test_full_turn_is_passed_literally_only_to_leader(self):
        action = "Ask Bast for terms; decide after review."
        bundle = self.turn_bundle(action)
        payload = ctx.build_actor_input(bundle, "leader", "contract", hero_action=action)
        self.assertEqual(payload["hero_action"], action)
        self.assertEqual(set(payload), {"role", "contract", "memory", "hero_action"})
        self.assertNotIn("turn_intake", payload)
        self.assertNotIn("addressed_to", payload)
        with self.assertRaisesRegex(ctx.ContextError, "only for the leader"):
            ctx.build_actor_input(bundle, "hero", "contract", hero_action=action)
        with self.assertRaisesRegex(ctx.ContextError, "requires the external exact hero_action"):
            ctx.build_actor_input(bundle, "leader", "contract")

    def test_full_turn_rejects_stale_or_truncated_intake(self):
        action = "Ask Bast for terms; decide after review."
        bundle = self.turn_bundle(action)
        with self.assertRaisesRegex(ctx.ContextError, "stale"):
            ctx.build_actor_input(bundle, "leader", "contract", hero_action=action + " More.")
        bundle["turn_intake"]["units"][1]["text"] = "decide after review."
        with self.assertRaisesRegex(ctx.ContextError, "exact hero_action text"):
            ctx.build_actor_input(bundle, "leader", "contract", hero_action=action)

    def response_context_bundle(self):
        return {"role_memory": {"leader": {
            "heard_dialogue": [
                {"speaker": "Bast", "recipient": "Marcus", "text": "Храм подстраивается под грани.", "manner": "ровно"},
                {"speaker": "Marcus", "recipient": "Bast", "text": "Все имеют шанс пройти."},
            ],
            "npc_memories": {
                "Marcus": {"private_memory": ["Кронмаршал ждёт ответа."], "heard_dialogue": []},
                "Bast": {"private_memory": ["Мне нужен месяц."], "observations": ["Она посмотрела на стол."]},
            },
        }}}

    def test_response_context_selects_existing_facts_and_preserves_speaker_recipient(self):
        bundle = self.response_context_bundle()
        payload = ctx.build_actor_input(bundle, "leader", "contract", response_context=[
            "/npc_memories/Marcus/private_memory/0", "/heard_dialogue/0",
        ])
        selected = payload["response_context"]
        self.assertEqual(selected, {
            "npc_memories": {"Marcus": {"private_memory": ["Кронмаршал ждёт ответа."]}},
            "heard_dialogue": [{"speaker": "Bast", "recipient": "Marcus",
                                 "text": "Храм подстраивается под грани.", "manner": "ровно"}],
        })
        self.assertNotIn("response_context", payload["contract"] if isinstance(payload["contract"], dict) else {})
        self.assertNotIn("/npc_memories/Marcus/private_memory/0", json.dumps(selected, ensure_ascii=False))

    def test_response_context_rejects_forged_or_non_memory_selection(self):
        bundle = self.response_context_bundle()
        for selection in (["/npc_memories/Marcus/private_memory/9"],
                          ["/npc_memories/Marcus/source_ids/0"],
                          {"npc": "Marcus", "fact": "invented"}):
            with self.subTest(selection=selection), self.assertRaises(ctx.ContextError):
                ctx.build_actor_input(bundle, "leader", "contract", response_context=selection)

    def test_response_context_rejects_dialogue_record_fields_before_projection(self):
        bundle = self.response_context_bundle()
        invalid_sets = (
            ["/heard_dialogue/0/text"],
            ["/npc_memories/Marcus/heard_dialogue/0/text"],
            ["/heard_dialogue/1", "/heard_dialogue/0/text"],
            ["/heard_dialogue/0/text", "/heard_dialogue/1"],
        )
        for selection in invalid_sets:
            with self.subTest(selection=selection), self.assertRaisesRegex(
                    ctx.ContextError, "heard_dialogue record whole"):
                ctx.build_actor_input(bundle, "leader", "contract", response_context=selection)

    def test_response_context_preserves_owner_and_rejects_ownerless_npc_pointer(self):
        bundle = self.response_context_bundle()
        payload = ctx.build_actor_input(bundle, "leader", "contract", response_context=[
            "/npc_memories/Bast/private_memory/0",
        ])
        self.assertEqual(payload["response_context"], {
            "npc_memories": {"Bast": {"private_memory": ["Мне нужен месяц."]}}
        })
        with self.assertRaisesRegex(ctx.ContextError, "existing NPC memory owner"):
            ctx.build_actor_input(bundle, "leader", "contract", response_context=["/npc_memories/Marcus"])

    def test_response_context_is_leader_only(self):
        bundle = {"role_memory": {"hero": {"private_memory": ["Я здесь."]}}}
        with self.assertRaisesRegex(ctx.ContextError, "only for the leader"):
            ctx.build_actor_input(bundle, "hero", "contract", response_context=["/private_memory/0"])

    def test_response_context_is_deep_copied_and_legacy_calls_are_unchanged(self):
        bundle = self.response_context_bundle()
        contract = {"rules": ["answer in scene"]}
        payload = ctx.build_actor_input(bundle, "leader", contract, response_context=[
            "/npc_memories/Marcus/private_memory/0",
        ])
        payload["response_context"]["npc_memories"]["Marcus"]["private_memory"][0] = "changed"
        payload["contract"]["rules"].append("changed")
        legacy = ctx.build_actor_input(bundle, "leader", contract)
        self.assertEqual(bundle["role_memory"]["leader"]["npc_memories"]["Marcus"]["private_memory"],
                         ["Кронмаршал ждёт ответа."])
        self.assertEqual(contract, {"rules": ["answer in scene"]})
        self.assertNotIn("response_context", legacy)
        self.assertEqual(set(legacy), {"role", "contract", "memory"})

    def test_full_turn_rejects_holes_and_overlaps(self):
        action = "Ask Bast for terms; decide after review."
        for bad_start in (len("Ask Bast for terms;") + 1, len("Ask Bast for terms;") - 1):
            bundle = self.turn_bundle(action)
            bundle["turn_intake"]["units"][1]["start"] = bad_start
            with self.subTest(bad_start=bad_start), self.assertRaisesRegex(ctx.ContextError, "contiguously cover"):
                ctx.build_actor_input(bundle, "leader", "contract", hero_action=action)

    def test_full_turn_blocked_unit_and_unknown_gap_reference_reject(self):
        action = "Ask Bast for terms; decide after review."
        bundle = self.turn_bundle(action)
        bundle["turn_intake"]["units"][1]["disposition"] = "blocked"
        with self.assertRaisesRegex(ctx.ContextError, "Blocked material"):
            ctx.build_actor_input(bundle, "leader", "contract", hero_action=action)
        bundle = self.turn_bundle(action)
        bundle["turn_intake"]["units"][0]["gap_ids"] = ["missing"]
        with self.assertRaisesRegex(ctx.ContextError, "unknown or duplicate context gap"):
            ctx.build_actor_input(bundle, "leader", "contract", hero_action=action)

    def test_intake_requires_external_action_and_rejects_invalid_addresses(self):
        action = "Ask Bast for terms; decide after review."
        bundle = self.turn_bundle(action)
        bundle["turn_intake"]["units"][0]["addressed_to"] = ["Unknown"]
        with self.assertRaisesRegex(ctx.ContextError, "addressed_to"):
            ctx.build_actor_input(bundle, "leader", "contract", hero_action=action)
        with self.assertRaisesRegex(ctx.ContextError, "nonempty exact string"):
            ctx.build_actor_input({"role_memory": {"leader": {}}}, "leader", "contract", hero_action="  ")

    def valid_decision(self, scene="Bast tapped the table. I can prepare it, but you decide after my review."):
        return {"scene": scene, "hero_position": "at the hearth", "hero_activity": "speaking",
                "local_result": "Bast will prepare terms.", "private_state": {}, "complete": False,
                "npc_decisions": [{"npc": "Bast", "decision": "Prepare terms.",
                "goal": "Protect her judgment.", "benefit": "Keep the choice informed.",
                "cost": "Spend time reviewing.", "retained_condition": "She decides after review.",
                "action_evidence": ["Ask Bast", "decide after review."],
                "scene_evidence": ["you decide after my review"]}]}

    def test_npc_decision_diagnostic_accepts_linked_literal_scene_and_empty_list(self):
        action = "Ask Bast for terms; decide after review."
        bundle = self.turn_bundle(action)
        response = self.valid_decision()
        before = json.dumps([bundle, response], ensure_ascii=False)
        checked = ctx.validate_leader_response(bundle, action, response)
        self.assertEqual(checked, response)
        self.assertEqual(json.dumps([bundle, response], ensure_ascii=False), before)
        response["npc_decisions"] = []
        self.assertEqual(ctx.validate_leader_response(bundle, action, response)["npc_decisions"], [])

    def test_npc_decision_diagnostic_rejects_unknown_npc_invalid_links_empty_cost_and_absent_evidence(self):
        action = "Ask Bast for terms; decide after review."
        cases = (
            ("npc", "Nobody", "unknown NPC"),
            ("action_evidence", ["not in action"], "not present in the literal hero_action"),
            ("action_evidence", [], "must contain literal hero_action text"),
            ("cost", "", "cost"),
            ("scene_evidence", [], "must contain literal scene text"),
            ("scene_evidence", ["not in scene"], "not present in the literal scene"),
        )
        for field, value, error in cases:
            bundle = self.turn_bundle(action)
            response = self.valid_decision()
            response["npc_decisions"][0][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ctx.ContextError, error):
                ctx.validate_leader_response(bundle, action, response)

    def live_fixture(self):
        bundle = {"role_memory": {
            "hero": {"experience": ["Beal's hand remembers the old scar."], "private_memory": ["hero-only memory"]},
            "leader": {"situation": "A tense room", "private_memory": ["leader-only note"],
                       "npc_memories": {
                           "Beal": {"experience": ["The hero memory must not be used as NPC memory."]},
                           "Marcus": {"experience": ["Marcus heard Bast's warning."], "private_memory": ["Marcus secret"]},
                           "Bast": {"experience": ["Bast waits by the door."], "private_memory": ["Bast secret"]}}}},
            "physical_staging": {"Marcus": "at the table", "Bast": "by the door"},
            "relationship_samples": ["Bast protects Beal without indulging him."]}
        actors = {"lead": {"role": "leader", "name": "Ведущий"},
                  "hero": {"role": "hero", "name": "Беал"},
                  "marcus": {"role": "npc", "name": "Marcus"},
                  "bast": {"role": "npc", "name": "Bast"}}
        craft = {"leader": "Maintain shared physical continuity.",
                 "hero": "First-person Beal, in the supplied tense and distance.",
                 "npc": "Use only own knowledge and heard events.",
                 "formatter": "Compose free literary prose; preserve played speech.",
                 "author_samples": [{"provenance": "author source P0040", "text": "Если бы не уроки Куйвиэорна, я бы на это даже не обратил внимание."}],
                 "character_voice_evidence": {"Beal": "Reads changed behavior through training."}}
        return ctx.initialize_live_session(bundle, hero_name="Беал", actors=actors,
                                           author_craft=craft, initial_actor="lead"), craft

    def live_accept(self, state, response, next_actor):
        packet = ctx.build_live_actor_input(state)
        envelope = {"packet_binding": packet["packet_binding"], "response": response}
        candidate = ctx.validate_live_response(state, envelope)
        ctx.accept_live_response(state, candidate, semantic_review={"accepted": True,
            "candidate_sha256": candidate["candidate_sha256"],
            "session_id": candidate["session_id"],
            "source_fingerprint": candidate["source_fingerprint"],
            "based_on_revision": candidate["based_on_revision"],
            "actor_id": candidate["actor_id"],
            "prior_transcript_sha256": candidate["prior_transcript_sha256"],
            "packet_fingerprint": candidate["packet_fingerprint"]}, next_actor=next_actor)
        return candidate

    def enacted_fixture(self, *, initial_actor="hero", history=None):
        state, craft = self.live_fixture()
        craft = {**craft, "turn_format": "enacted-v2"}
        fresh = ctx.initialize_live_session(state["bundle"], hero_name="Беал", actors=state["actors"],
            author_craft=craft, initial_actor=initial_actor, initial_public_events=history)
        return fresh, craft

    def enacted_candidate(self, state, turn):
        packet = ctx.build_live_actor_input(state)
        return ctx.validate_live_response(state, {"packet_binding": packet["packet_binding"],
            "response": {"turn": turn}})

    def enacted_review(self, state, candidate):
        packet_binding = ctx.build_live_actor_input(state)["packet_binding"]
        return {"verdict": "pass", "issues": [],
                "binding": {**packet_binding, "candidate_sha256": candidate["candidate_sha256"]}}

    def enacted_accept(self, state, candidate, next_actor=None, review=None):
        return ctx.accept_live_response(state, candidate,
            semantic_review=self.enacted_review(state, candidate) if review is None else review,
            next_actor=next_actor)

    def test_live_role_inputs_deliver_craft_owner_memory_and_public_hearing(self):
        state, craft = self.live_fixture()
        leader = ctx.build_live_actor_input(state)
        self.assertEqual(leader["craft"]["author_samples"], craft["author_samples"])
        self.assertEqual(leader["craft"]["role_guidance"], craft["leader"])
        self.live_accept(state, {"public_events": [{"kind": "action", "text": "Bast set the lamp down.",
            "recipient": None, "audience": ["hero", "marcus", "bast"]}]}, "hero")
        hero = ctx.build_live_actor_input(state)
        self.assertEqual(hero["craft"]["role_guidance"], craft["hero"])
        self.assertEqual(hero["memory"]["own_memory"]["private_memory"], ["hero-only memory"])
        self.assertEqual(hero["heard_public_events"][0]["text"], "Bast set the lamp down.")
        self.live_accept(state, {"private_text": "Я заметил, как дрогнуло пламя.", "public_events": [
            {"kind": "speech", "text": "Маркус, ответь прямо.", "recipient": "marcus", "audience": ["hero", "marcus", "bast"]}]}, "marcus")
        npc = ctx.build_live_actor_input(state)
        self.assertEqual(npc["craft"]["role_guidance"], craft["npc"])
        self.assertEqual(npc["memory"]["own_memory"]["private_memory"], ["Marcus secret"])
        self.assertNotIn("Bast secret", json.dumps(npc, ensure_ascii=False))
        self.assertNotIn("hero-only memory", json.dumps(npc, ensure_ascii=False))
        # The utterance is addressed to Marcus, but the declared audience also heard it.
        self.assertEqual(npc["heard_public_events"][-1]["text"], "Маркус, ответь прямо.")

    def test_live_sequencing_rejects_stale_parallel_actor_and_source_mutation(self):
        state, _ = self.live_fixture()
        stale_leader_packet = ctx.build_live_actor_input(state)
        self.live_accept(state, {"public_events": [{"kind": "action", "text": "The door clicked.",
            "recipient": None, "audience": ["hero", "marcus", "bast"]}]}, "hero")
        stale_response = {"packet_binding": stale_leader_packet["packet_binding"],
                          "response": {"public_events": []}}
        with self.assertRaisesRegex(ctx.ContextError, "packet binding is stale"):
            ctx.validate_live_response(state, stale_response)
        with self.assertRaisesRegex(ctx.ContextError, "host-selected current actor"):
            ctx.build_live_actor_input(state, "marcus")
        self.assertEqual(stale_leader_packet["based_on_revision"], 0)
        state["author_craft"]["hero"] = "changed after initialization"
        with self.assertRaisesRegex(ctx.ContextError, "changed after initialization"):
            ctx.build_live_actor_input(state)

    def test_live_initial_public_events_use_explicit_audience(self):
        state, craft = self.live_fixture()
        event = {"speaker_actor_id": "bast", "kind": "speech", "text": "The room is not empty.",
                 "recipient": "marcus", "audience": ["hero", "marcus", "bast"], "source_ref": "C016-P0045"}
        fresh = ctx.initialize_live_session(state["bundle"], hero_name="Беал", actors=state["actors"],
            author_craft=craft, initial_actor="hero", initial_public_events=[event])
        packet = ctx.build_live_actor_input(fresh)
        self.assertEqual(packet["participants"]["marcus"], {"role": "npc", "name": "Marcus"})
        self.assertEqual(packet["heard_public_events"][0]["text"], event["text"])
        self.assertEqual(packet["heard_public_events"][0]["source_ref"], "C016-P0045")
        hero_packet = ctx.build_live_actor_input(fresh, "hero")
        self.assertEqual(hero_packet["heard_public_events"][0]["text"], event["text"])
        envelope = {"packet_binding": packet["packet_binding"], "response": {"public_events": []}}
        candidate = ctx.validate_live_response(fresh, envelope)
        ctx.accept_live_response(fresh, candidate, semantic_review={"accepted": True,
            "candidate_sha256": candidate["candidate_sha256"],
            "session_id": candidate["session_id"],
            "source_fingerprint": candidate["source_fingerprint"],
            "based_on_revision": candidate["based_on_revision"],
            "actor_id": candidate["actor_id"],
            "prior_transcript_sha256": candidate["prior_transcript_sha256"],
            "packet_fingerprint": candidate["packet_fingerprint"]}, next_actor=None)
        ctx.finish_live_session(fresh)
        formatter = ctx.build_live_formatter_input(fresh)
        self.assertEqual(formatter["complete_accepted_transcript"], [])
        self.assertEqual(formatter["frozen_ordered_spans"], [])
        self.assertIn("Source-history events are context only", formatter["instruction"])
        event["audience"] = ["marcus"]
        fresh = ctx.initialize_live_session(state["bundle"], hero_name="Беал", actors=state["actors"],
            author_craft=craft, initial_actor="hero", initial_public_events=[event])
        self.assertEqual(ctx.build_live_actor_input(fresh)["heard_public_events"], [])

    def test_enacted_v2_interleaves_inner_and_keeps_it_hero_only(self):
        state, _ = self.enacted_fixture()
        packet = ctx.build_live_actor_input(state)
        self.assertEqual(packet["response_schema"]["response"], {"turn": [
            {"kind": "inner", "text": "hero-only text"},
            {"kind": "action", "text": "observable text", "audience": ["actor IDs who perceive it"]},
            {"kind": "speech", "segments": [{"to": "actor ID or null", "text": "spoken words"}],
             "delivery": "speaker-owned observable attribution/action prose or empty",
             "audience": ["actor IDs who perceive it"]},
            {"kind": "speech", "pieces": [
                {"kind": "spoken", "to": "actor ID or null", "text": "spoken fragment"},
                {"kind": "delivery", "text": "speaker-owned observable manner/action",
                 "form": "attribution"},
                {"kind": "spoken", "to": "actor ID or null", "text": "continued spoken fragment"}],
             "audience": ["actor IDs who perceive it"]}]})
        self.assertEqual(packet["response_schema"]["delivery_form"], {
            "field": "speech.pieces[].form", "allowed_values": ["attribution", "independent"],
            "default": "attribution"})
        candidate = self.enacted_candidate(state, [
            {"kind": "speech", "segments": [{"to": "marcus", "text": "Ты слышал?"}],
             "delivery": "спросил я, не отводя взгляда", "audience": ["hero", "marcus", "bast"]},
            {"kind": "inner", "text": "После его ответа я решил не торопиться."},
            {"kind": "action", "text": "Я убрал руку от края стола.", "audience": ["hero", "marcus", "bast"]}])
        self.enacted_accept(state, candidate, next_actor="marcus")
        self.assertEqual([item["kind"] for item in state["transcript"]], ["speech", "inner", "action"])
        hero_projection = ctx._live_actor_memory(state, "hero")
        npc = ctx.build_live_actor_input(state, "marcus")
        self.assertIn("После его ответа", json.dumps(hero_projection, ensure_ascii=False))
        self.assertNotIn("После его ответа", json.dumps(npc, ensure_ascii=False))
        npc_turn = self.enacted_candidate(state, [{"kind": "action", "text": "Маркус отвёл глаза.",
                                                   "audience": ["hero", "marcus", "bast"]}])
        self.enacted_accept(state, npc_turn, next_actor="lead")
        self.assertNotIn("После его ответа", json.dumps(ctx.build_live_actor_input(state, "lead"), ensure_ascii=False))

    def test_enacted_v2_delivery_and_multi_address_speech_survive_render(self):
        state, _ = self.enacted_fixture()
        candidate = self.enacted_candidate(state, [
            {"kind": "speech", "segments": [
                {"to": "bast", "text": "Баст, послушай."},
                {"to": "marcus", "text": "Маркус, ответь прямо!"}],
             "delivery": "сказал я, глядя на обоих", "audience": ["hero", "marcus", "bast"]}])
        self.enacted_accept(state, candidate, next_actor="bast")
        heard = ctx.build_live_actor_input(state, "bast")["heard_public_events"]
        self.assertEqual(heard[0]["segments"], candidate["turn"][0]["segments"])
        self.assertEqual(heard[0]["delivery"], "сказал я, глядя на обоих")
        npc_candidate = self.enacted_candidate(state, [])
        self.enacted_accept(state, npc_candidate)
        ctx.finish_live_session(state)
        formatter = ctx.build_live_formatter_input(state)
        self.assertEqual(formatter["rendered_scene"],
                         "— Баст, послушай. Маркус, ответь прямо! — сказал я, глядя на обоих.")
        self.assertEqual(formatter["ordered_slices"], [{"offset": 0,
            "text": formatter["rendered_scene"], "item": 0, "kind": "speech"}])
        validation = ctx.validate_live_prose(formatter, formatter["rendered_scene"],
            semantic_review={"accepted": True,
                "prose_sha256": ctx._staged_hash({"prose": formatter["rendered_scene"],
                                                  "transcript_sha256": formatter["transcript_sha256"]}),
                "transcript_sha256": formatter["transcript_sha256"]})
        self.assertTrue(validation["accepted"])

    def test_enacted_v2_speech_pieces_keep_mid_utterance_delivery_and_exact_slices(self):
        state, _ = self.enacted_fixture()
        speech = {"kind": "speech", "pieces": [
            {"kind": "spoken", "to": "bast", "text": "Привет!"},
            {"kind": "delivery", "text": "сказал Беал, застенчиво почесав за ухом"},
            {"kind": "spoken", "to": "marcus", "text": "А ты что думаешь?"}],
            "audience": ["hero", "bast", "marcus"]}
        original = json.loads(json.dumps(speech, ensure_ascii=False))
        candidate = self.enacted_candidate(state, [speech])
        self.assertEqual(speech, original)
        self.assertEqual(candidate["turn"][0]["pieces"], original["pieces"])
        self.enacted_accept(state, candidate, next_actor="bast")
        heard = ctx.build_live_actor_input(state, "bast")["heard_public_events"]
        self.assertEqual(heard[0]["pieces"], original["pieces"])
        npc_turn = self.enacted_candidate(state, [])
        self.enacted_accept(state, npc_turn)
        ctx.finish_live_session(state)
        formatter = ctx.build_live_formatter_input(state)
        rendered, slices = ctx.render_enacted_scene(state)
        self.assertEqual(rendered,
            "— Привет! — сказал Беал, застенчиво почесав за ухом. — А ты что думаешь?")
        self.assertEqual(rendered, formatter["rendered_scene"])
        self.assertEqual(slices, formatter["ordered_slices"])
        self.assertEqual([rendered[s["offset"]:s["offset"] + len(s["text"])] for s in slices],
                         [s["text"] for s in slices])

    def test_enacted_v2_independent_delivery_preserves_sentence_boundaries_and_fragments(self):
        state, _ = self.enacted_fixture()
        speech = {"kind": "speech", "pieces": [
            {"kind": "spoken", "to": "bast", "text": "Я вернусь."},
            {"kind": "delivery", "text": "Я убрал руку со стола.", "form": "independent"},
            {"kind": "spoken", "to": "bast", "text": "Завтра."}],
            "audience": ["hero", "bast"]}
        original_pieces = json.loads(json.dumps(speech["pieces"], ensure_ascii=False))
        candidate = self.enacted_candidate(state, [speech])
        self.assertEqual(speech["pieces"], original_pieces)
        self.assertEqual(candidate["turn"][0]["pieces"], original_pieces)
        self.enacted_accept(state, candidate, next_actor="bast")
        heard = ctx.build_live_actor_input(state, "bast")["heard_public_events"]
        self.assertEqual(heard[0]["pieces"], original_pieces)
        npc_turn = self.enacted_candidate(state, [])
        self.enacted_accept(state, npc_turn)
        ctx.finish_live_session(state)
        formatter = ctx.build_live_formatter_input(state)
        rendered, slices = ctx.render_enacted_scene(state)
        expected = "— Я вернусь. — Я убрал руку со стола. — Завтра."
        self.assertEqual(rendered, expected)
        self.assertEqual(formatter["rendered_scene"], expected)
        self.assertEqual([rendered[s["offset"]:s["offset"] + len(s["text"])] for s in slices],
                         [s["text"] for s in slices])

        attributed, _ = ctx.render_enacted_scene({"turn": [{"kind": "speech", "pieces": [
            {"kind": "spoken", "to": None, "text": "Я вернусь."},
            {"kind": "delivery", "text": "сказал я"},
            {"kind": "spoken", "to": None, "text": "Завтра."}]}]})
        self.assertEqual(attributed, "— Я вернусь, — сказал я. — Завтра.")

    def test_enacted_v2_join_previous_joins_only_same_turn_and_keeps_inner_private(self):
        state, _ = self.enacted_fixture()
        candidate = self.enacted_candidate(state, [
            {"kind": "speech", "pieces": [
                {"kind": "spoken", "to": "marcus", "text": "Нет"},
                {"kind": "delivery", "text": "пробормотал я, чуть растекаясь в кресле,"},
                {"kind": "spoken", "to": "marcus", "text": "не слушая до конца."}],
             "audience": ["hero", "marcus"]},
            {"kind": "inner", "text": "Я уже решил не торопиться.", "join_previous": True},
            {"kind": "action", "text": "Я убрал ладонь со стола.",
             "audience": ["hero", "marcus"], "join_previous": True}])
        self.enacted_accept(state, candidate, next_actor="marcus")
        npc_packet = ctx.build_live_actor_input(state, "marcus")
        hero_memory = ctx._live_actor_memory(state, "hero")
        self.assertIn("Я уже решил не торопиться.", json.dumps(hero_memory, ensure_ascii=False))
        self.assertNotIn("Я уже решил не торопиться.", json.dumps(npc_packet, ensure_ascii=False))
        self.assertEqual(state["transcript"][1]["join_previous"], True)
        self.assertEqual(state["transcript"][2]["join_previous"], True)
        with self.assertRaisesRegex(ctx.ContextError, "previous item"):
            self.enacted_candidate(state, [{"kind": "action", "text": "Ещё один шаг.",
                                            "audience": ["hero", "marcus"], "join_previous": True}])
        npc_turn = self.enacted_candidate(state, [])
        self.enacted_accept(state, npc_turn)
        ctx.finish_live_session(state)
        formatter = ctx.build_live_formatter_input(state)
        rendered, slices = ctx.render_enacted_scene(state)
        expected = ("— Нет, — пробормотал я, чуть растекаясь в кресле, — не слушая до конца."
                    " Я уже решил не торопиться. Я убрал ладонь со стола.")
        self.assertEqual(rendered, expected)
        self.assertEqual(formatter["rendered_scene"], expected)
        self.assertEqual([rendered[s["offset"]:s["offset"] + len(s["text"])] for s in slices],
                         [s["text"] for s in slices])

    def test_enacted_v2_piece_recipients_and_join_flags_are_validated(self):
        state, _ = self.enacted_fixture()
        base = {"kind": "speech", "pieces": [
            {"kind": "spoken", "to": "missing", "text": "Да."}], "audience": ["hero"]}
        with self.assertRaisesRegex(ctx.ContextError, "recipient"):
            self.enacted_candidate(state, [base])
        with self.assertRaisesRegex(ctx.ContextError, "join_previous"):
            self.enacted_candidate(state, [{"kind": "action", "text": "Шаг.",
                "audience": ["hero"], "join_previous": "true"}])
        with self.assertRaisesRegex(ctx.ContextError, "previous item"):
            self.enacted_candidate(state, [{"kind": "action", "text": "Шаг.",
                "audience": ["hero"], "join_previous": True}])

    def test_enacted_v2_review_issues_pending_and_foreign_binding_block_commit(self):
        state, _ = self.enacted_fixture()
        candidate = self.enacted_candidate(state, [{"kind": "action", "text": "Я замолчал.",
                                                    "audience": ["hero", "lead"]}])
        good = self.enacted_review(state, candidate)
        bad_reviews = [
            {**good, "verdict": "revise"},
            {**good, "issues": [{"issue": "motivation unclear"}]},
            {**good, "verdict": "pending"},
            {**good, "binding": {**good["binding"], "session_id": "foreign"}},
        ]
        for review in bad_reviews:
            with self.subTest(review=review), self.assertRaisesRegex(ctx.ContextError, "enacted-v2 requires"):
                self.enacted_accept(state, candidate, review=review)
            self.assertEqual(state["revision"], 0)
        packet = ctx.build_live_actor_input(state)
        with self.assertRaisesRegex(ctx.ContextError, "packet binding"):
            ctx.validate_live_response(state, {"packet_binding": {**packet["packet_binding"],
                "session_id": "foreign"}, "response": {"turn": candidate["turn"]}})

    def test_enacted_renderer_closes_delivery_without_doubling_terminal(self):
        for delivery in ("сказал я", "сказал я.", "спросил я?", "выкрикнул я!", "протянул я…"):
            expected = delivery if delivery.endswith((".", "?", "!", "…")) else delivery + "."
            rendered, slices = ctx.render_enacted_scene({"turn": [{"kind": "speech",
                "segments": [{"to": None, "text": "Да."}], "delivery": delivery,
                "audience": ["hero"]}]})
            self.assertEqual(rendered, "— Да, — " + expected)
            self.assertEqual(slices[0]["text"], rendered)

    def test_enacted_v2_renderer_uses_exact_ordered_map_and_excludes_source_history(self):
        history = [{"speaker_actor_id": "bast", "kind": "speech", "text": "Историческая реплика.",
                    "recipient": "hero", "audience": ["hero"], "source_ref": "P0040"}]
        state, _ = self.enacted_fixture(history=history)
        candidate = self.enacted_candidate(state, [
            {"kind": "action", "text": "Я вошёл." , "audience": ["hero", "lead"]},
            {"kind": "inner", "text": "Да."},
            {"kind": "speech", "segments": [{"to": None, "text": "Да."}],
             "delivery": "сказал я", "audience": ["hero", "bast"]}])
        self.enacted_accept(state, candidate)
        ctx.finish_live_session(state)
        formatter = ctx.build_live_formatter_input(state)
        rendered, slices = ctx.render_enacted_scene(state)
        self.assertEqual(rendered, formatter["rendered_scene"])
        self.assertEqual(slices, formatter["ordered_slices"])
        self.assertNotIn("Историческая реплика", rendered)
        self.assertEqual([piece["item"] for piece in slices], [0, 1, 2])
        self.assertEqual([rendered[piece["offset"]:piece["offset"] + len(piece["text"])]
                          for piece in slices], [piece["text"] for piece in slices])
        review = {"accepted": True,
            "prose_sha256": ctx._staged_hash({"prose": rendered, "transcript_sha256": formatter["transcript_sha256"]}),
            "transcript_sha256": formatter["transcript_sha256"]}
        for wrong in ("Да. Я вошёл. Да, — сказал я", "Да. Я вошёл. Да, — сказал я; Да.",
                      "Я вошёл. Да, — сказал я"):
            with self.subTest(wrong=wrong), self.assertRaisesRegex(ctx.ContextError, "exactly match"):
                ctx.validate_live_prose(formatter, wrong, semantic_review=review)
        self.assertTrue(ctx.validate_live_prose(formatter, rendered, semantic_review=review)["accepted"])

        tampered_maps = []
        empty = json.loads(json.dumps(formatter, ensure_ascii=False))
        empty["ordered_slices"] = []
        tampered_maps.append(empty)
        reordered = json.loads(json.dumps(formatter, ensure_ascii=False))
        reordered["ordered_slices"] = list(reversed(reordered["ordered_slices"]))
        tampered_maps.append(reordered)
        forged_offset = json.loads(json.dumps(formatter, ensure_ascii=False))
        forged_offset["ordered_slices"][0]["offset"] = 999
        tampered_maps.append(forged_offset)
        for tampered in tampered_maps:
            with self.subTest(ordered_slices=tampered["ordered_slices"]), self.assertRaisesRegex(
                    ctx.ContextError, "ordered slices"):
                ctx.validate_live_prose(tampered, rendered, semantic_review=review)

    def test_enacted_renderer_marks_role_labels_without_reformatting_played_items(self):
        rendered, slices = ctx.render_enacted_scene({"turn": [
            {"kind": "speech", "segments": [{"to": None, "text": "Привет!"}],
             "delivery": "сказал Беал, застенчиво почесав за ухом", "audience": ["hero"],
             "speaker_role": "hero", "speaker_name": "Беал"}],
            "actors": {"hero": {"role": "hero", "name": "Беал"}}}, include_role_labels=True)
        self.assertEqual(rendered, "ГЕРОЙ (Беал): — Привет! — сказал Беал, застенчиво почесав за ухом.")
        self.assertEqual(slices[0]["offset"], 0)

    def test_live_owner_context_fork_preserves_played_prefix_and_scopes_new_memory(self):
        state, _ = self.enacted_fixture(initial_actor="lead")
        leader_turn = self.enacted_candidate(state, [{"kind": "action", "text": "В очереди стало тише.",
                                                     "audience": ["hero", "marcus", "bast"]}])
        self.enacted_accept(state, leader_turn, next_actor="hero")
        hero_turn = self.enacted_candidate(state, [
            {"kind": "inner", "text": "Счёт игл я пока не раскрыл."},
            {"kind": "speech", "segments": [{"to": "marcus", "text": "Ты узнаёшь эту работу?"}],
             "delivery": "спросил я, повернув иглу к свету", "audience": ["hero", "marcus", "bast"]}])
        self.enacted_accept(state, hero_turn, next_actor="marcus")
        original_json = json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        transcript_bytes = json.dumps(state["transcript"], ensure_ascii=False,
                                      sort_keys=True, separators=(",", ":"))
        prefix_render, prefix_slices = ctx.render_enacted_scene(state)
        old_packet = ctx.build_live_actor_input(state)
        old_transcript_hash = state["transcript_sha256"]
        old_source_fingerprint = state["source_fingerprint"]
        old_owner_experience = list(state["bundle"]["role_memory"]["leader"]["npc_memories"]["Marcus"]["experience"])
        added_fact = "Маркус распознаёт назначение иглы: её ставят у входа как сигнал." 
        host_reason = "Источник C037 подтверждает функцию иглы; ветка явно меняет только знание Маркуса."

        forked = ctx.fork_live_owner_context(state, actor_id="marcus",
            extra_experience=[added_fact], reason=host_reason, session_id="live-owner-fork")
        self.assertEqual(json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":")), original_json)
        self.assertEqual(json.dumps(forked["transcript"], ensure_ascii=False,
                                    sort_keys=True, separators=(",", ":")), transcript_bytes)
        self.assertEqual(forked["transcript_sha256"], old_transcript_hash)
        self.assertNotEqual(forked["source_fingerprint"], old_source_fingerprint)
        self.assertEqual(forked["bundle"]["role_memory"]["leader"]["npc_memories"]["Marcus"]["experience"],
                         [*old_owner_experience, added_fact])
        self.assertEqual(forked["context_fork"], {
            "parent_session_id": state["session_id"],
            "parent_source_fingerprint": old_source_fingerprint,
            "parent_transcript_sha256": old_transcript_hash,
            "reason": host_reason})
        self.assertEqual(ctx.render_enacted_scene(forked), (prefix_render, prefix_slices))

        with self.assertRaisesRegex(ctx.ContextError, "packet binding"):
            ctx.validate_live_response(forked, {"packet_binding": old_packet["packet_binding"],
                "response": {"turn": [{"kind": "action", "text": "Серая кивнула.",
                                        "audience": ["hero", "marcus", "bast"]}]}})
        npc_packet = ctx.build_live_actor_input(forked)
        self.assertIn(added_fact, npc_packet["memory"]["own_memory"]["experience"])
        self.assertNotIn(host_reason, json.dumps(npc_packet, ensure_ascii=False))
        new_candidate = ctx.validate_live_response(forked, {"packet_binding": npc_packet["packet_binding"],
            "response": {"turn": [{"kind": "action", "text": "Маркус посмотрел на иглу.",
                                    "audience": ["hero", "marcus", "bast"]}]}})
        self.assertEqual(new_candidate["source_fingerprint"], forked["source_fingerprint"])
        self.enacted_accept(forked, new_candidate, next_actor="hero")

        hero_packet = ctx.build_live_actor_input(forked)
        self.assertNotIn(added_fact, json.dumps(hero_packet, ensure_ascii=False))
        self.assertNotIn(host_reason, json.dumps(hero_packet, ensure_ascii=False))
        self.enacted_accept(forked, self.enacted_candidate(forked, []), next_actor="bast")
        other_npc_packet = ctx.build_live_actor_input(forked)
        self.assertNotIn(added_fact, json.dumps(other_npc_packet, ensure_ascii=False))
        self.assertNotIn(host_reason, json.dumps(other_npc_packet, ensure_ascii=False))
        self.enacted_accept(forked, self.enacted_candidate(forked, []), next_actor="lead")
        leader_packet = ctx.build_live_actor_input(forked)
        self.assertNotIn(added_fact, json.dumps(leader_packet, ensure_ascii=False))
        self.assertNotIn(host_reason, json.dumps(leader_packet, ensure_ascii=False))

    def test_live_owner_context_fork_rejects_invalid_inputs_without_mutation(self):
        state, _ = self.enacted_fixture(initial_actor="marcus")
        before = json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        invalid = [
            {"actor_id": "hero", "extra_experience": ["new fact"], "reason": "source", "session_id": "fork2"},
            {"actor_id": "lead", "extra_experience": ["new fact"], "reason": "source", "session_id": "fork1"},
            {"actor_id": "marcus", "extra_experience": ["new fact"], "reason": "source", "session_id": state["session_id"]},
            {"actor_id": "marcus", "extra_experience": ["new fact"], "reason": "source", "session_id": "bad/id"},
            {"actor_id": "marcus", "extra_experience": ["new fact"], "reason": " ", "session_id": "fork3"},
            {"actor_id": "marcus", "extra_experience": ["  "], "reason": "source", "session_id": "fork4"},
            {"actor_id": "marcus", "extra_experience": [], "reason": "source", "session_id": "fork5"},
            {"actor_id": "marcus", "extra_experience": "new fact", "reason": "source", "session_id": "fork6"},
        ]
        for args in invalid:
            with self.subTest(args=args), self.assertRaises(ctx.ContextError):
                ctx.fork_live_owner_context(state, **args)
            self.assertEqual(json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":")), before)

        for flag in ("finished", "awaiting_finish"):
            inactive = json.loads(before)
            inactive[flag] = True
            inactive_before = json.dumps(inactive, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            with self.subTest(flag=flag), self.assertRaisesRegex(ctx.ContextError, "active, unfinished"):
                ctx.fork_live_owner_context(inactive, actor_id="lead", extra_experience=["new fact"],
                                            reason="source", session_id="inactive-fork")
            self.assertEqual(json.dumps(inactive, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                             inactive_before)

        leader, _ = self.enacted_fixture(initial_actor="lead")
        leader_before = json.dumps(leader, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with self.assertRaisesRegex(ctx.ContextError, "current NPC owner"):
            ctx.fork_live_owner_context(leader, actor_id="lead", extra_experience=["new fact"],
                                        reason="source", session_id="leader-fork")
        self.assertEqual(json.dumps(leader, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                         leader_before)

    def test_live_response_envelope_rejects_cross_session_and_different_initial_history(self):
        state, craft = self.live_fixture()
        packet = ctx.build_live_actor_input(state)
        envelope = {"packet_binding": packet["packet_binding"], "response": {"public_events": []}}
        other_session = ctx.initialize_live_session(state["bundle"], hero_name="Беал", actors=state["actors"],
            author_craft=craft, initial_actor="lead", session_id="live2")
        with self.assertRaisesRegex(ctx.ContextError, "packet binding"):
            ctx.validate_live_response(other_session, envelope)

        event = {"speaker_actor_id": "bast", "kind": "speech", "text": "Other opening.",
                 "recipient": None, "audience": ["lead", "hero"]}
        other_history = ctx.initialize_live_session(state["bundle"], hero_name="Беал", actors=state["actors"],
            author_craft=craft, initial_actor="lead", initial_public_events=[event])
        self.assertEqual(state["session_id"], other_history["session_id"])
        self.assertEqual(state["source_fingerprint"], other_history["source_fingerprint"])
        self.assertNotEqual(state["transcript_sha256"], other_history["transcript_sha256"])
        with self.assertRaisesRegex(ctx.ContextError, "packet binding"):
            ctx.validate_live_response(other_history, envelope)

    def test_live_old_response_from_same_actor_is_rejected_on_later_turn(self):
        state, _ = self.live_fixture()
        old_actor_packet = ctx.build_live_actor_input(state)
        old_envelope = {"packet_binding": old_actor_packet["packet_binding"],
                        "response": {"public_events": []}}
        self.live_accept(state, {"public_events": []}, "hero")
        self.live_accept(state, {"public_events": []}, "lead")
        self.assertEqual(state["current_actor"], old_actor_packet["actor_id"])
        with self.assertRaisesRegex(ctx.ContextError, "packet binding is stale"):
            ctx.validate_live_response(state, old_envelope)

    def test_live_response_requires_envelope_and_review_binding(self):
        state, _ = self.live_fixture()
        with self.assertRaisesRegex(ctx.ContextError, "packet_binding envelope"):
            ctx.validate_live_response(state, {"public_events": []})
        self.live_accept(state, {"public_events": []}, "hero")
        packet = ctx.build_live_actor_input(state)
        candidate = ctx.validate_live_response(state, {"packet_binding": packet["packet_binding"],
            "response": {"public_events": []}})
        review = {"accepted": True, "candidate_sha256": candidate["candidate_sha256"],
            "session_id": candidate["session_id"], "source_fingerprint": candidate["source_fingerprint"],
            "based_on_revision": candidate["based_on_revision"],
            "actor_id": candidate["actor_id"],
            "prior_transcript_sha256": candidate["prior_transcript_sha256"],
            "packet_fingerprint": candidate["packet_fingerprint"]}
        review["prior_transcript_sha256"] = "0" * 64
        with self.assertRaisesRegex(ctx.ContextError, "semantic review"):
            ctx.accept_live_response(state, candidate, semantic_review=review, next_actor=None)

    def test_live_finish_formatter_and_frozen_hero_spans_require_exact_order(self):
        state, craft = self.live_fixture()
        self.live_accept(state, {"public_events": [{"kind": "action", "text": "The lamp trembled.",
            "recipient": None, "audience": ["hero", "marcus", "bast"]}]}, "hero")
        self.live_accept(state, {"private_text": "Я не стал отводить взгляд.", "public_events": [
            {"kind": "speech", "text": "Что ты скрываешь?", "recipient": "marcus", "audience": ["hero", "marcus", "bast"]}]}, "marcus")
        self.live_accept(state, {"public_events": [{"kind": "speech", "text": "Ничего.",
            "recipient": "hero", "audience": ["hero", "marcus", "bast"]}]}, None)
        with self.assertRaisesRegex(ctx.ContextError, "explicitly finished"):
            ctx.build_live_formatter_input(state)
        ctx.finish_live_session(state)
        fmt = ctx.build_live_formatter_input(state)
        self.assertEqual(fmt["author_samples"], craft["author_samples"])
        self.assertEqual([e["speaker_name"] for e in fmt["complete_accepted_transcript"]], ["Ведущий", "Беал", "Marcus"])
        self.assertNotIn("Marcus secret", json.dumps(fmt, ensure_ascii=False))
        spans = fmt["frozen_hero_spans"]
        self.assertEqual(spans, ["Я не стал отводить взгляд.", "Что ты скрываешь?"])
        prose = "Фитиль качнулся. Я не стал отводить взгляд. — Что ты скрываешь? — Ничего."
        digest = ctx.canonical_sha256({"prose": prose, "transcript_sha256": fmt["transcript_sha256"]})
        review = {"accepted": True, "prose_sha256": digest, "transcript_sha256": fmt["transcript_sha256"]}
        self.assertTrue(ctx.validate_live_prose(fmt, prose, semantic_review=review)["accepted"])
        for bad in ("Фитиль качнулся. Что ты скрываешь? Я не стал отводить взгляд. — Ничего.",
                    "Фитиль качнулся. — Что ты скрываешь? — Ничего."):
            bad_digest = ctx.canonical_sha256({"prose": bad, "transcript_sha256": fmt["transcript_sha256"]})
            bad_review = {"accepted": True, "prose_sha256": bad_digest, "transcript_sha256": fmt["transcript_sha256"]}
            with self.assertRaisesRegex(ctx.ContextError, "omits or reorders"):
                ctx.validate_live_prose(fmt, bad, semantic_review=bad_review)

    def logical_fixture(self, *, initial_actor="hero"):
        state, craft = self.live_fixture()
        guidance = {"leader": "Set observable external events only.",
                    "hero": "Choose behavior from the hero's knowledge and motives.",
                    "npc": "Choose behavior from this NPC's own memory and knowledge."}
        logical = ctx.initialize_logical_session(state["bundle"], hero_name="Беал", actors=state["actors"],
            author_craft=craft, actor_guidance=guidance, initial_actor=initial_actor,
            legacy_motivation=True,
            initial_actor_state={"hero": {"position": "near the table", "activity": "listening"},
                                 "bast": {"position": "by the door", "activity": "waiting"}})
        return logical, guidance

    def logical_candidate(self, state, turn):
        packet = ctx.build_logical_actor_input(state)
        return ctx.validate_logical_response(state, {"packet_binding": packet["packet_binding"],
            "response": {"turn": turn}})

    def test_logical_actor_packet_only_advertises_role_permitted_items(self):
        for actor, kinds in [("lead", {"action", "resolution"}), ("hero", {"inner", "action", "communication"}), ("bast", {"inner", "action", "communication", "resolution"})]:
            state, _ = self.logical_fixture(initial_actor=actor)
            packet = ctx.build_logical_actor_input(state)
            self.assertEqual({item["kind"] for item in packet["response_schema"]["turn"]}, kinds)
            self.assertIn('"packet_binding"', packet["instruction"])
            self.assertIn('"response"', packet["instruction"])

    def logical_accept(self, state, candidate, next_actor=None, review=None):
        review = {"verdict": "continue", "issues": [],
                  "binding": ctx.logical_continuation_binding(state, candidate)} if review is None else review
        return ctx.accept_logical_response(state, candidate, continuation_review=review, next_actor=next_actor)

    def test_logical_v3_keeps_private_decisions_owned_and_writer_pov_filtered(self):
        state, _ = self.logical_fixture()
        packet = ctx.build_logical_actor_input(state)
        action_schema = next(item for item in packet["response_schema"]["turn"] if item["kind"] == "action")
        self.assertIn("position_after", action_schema)
        self.assertIn("activity_after", action_schema)
        self.assertIn("record that resulting state", packet["instruction"])
        candidate = self.logical_candidate(state, [
            {"kind": "inner", "motive": "Не хочу объяснять ему снова.", "emotion": "раздражение, удерживаемое под контролем"},
            {"kind": "action", "status": "performed", "action": "Закатываю глаза и отвожу взгляд к двери.",
             "attention": "проверяю, свободен ли выход", "intensity": "сдержанно", "audience": ["hero", "marcus"],
             "position_after": "standing by the table", "activity_after": "watching the door"},
            {"kind": "communication", "recipient": "marcus", "audience": ["hero", "marcus", "bast"],
             "content": "Требую ответить, видел ли он, кто вошел; не обвиняю его.",
             "manner": "прямо, без насмешки", "intensity": "настойчиво"}])
        self.logical_accept(state, candidate, next_actor="bast")
        npc_packet = ctx.build_logical_actor_input(state, "bast")
        self.assertNotIn("author_samples", npc_packet["craft"])
        self.assertNotIn("Если бы не уроки", json.dumps(npc_packet, ensure_ascii=False))
        self.assertIn("Bast secret", json.dumps(npc_packet, ensure_ascii=False))
        self.assertNotIn("Закатываю глаза", json.dumps(npc_packet["heard_events"], ensure_ascii=False))
        self.assertNotIn("Не хочу объяснять ему снова", json.dumps(npc_packet, ensure_ascii=False))
        self.assertEqual(npc_packet["memory"]["own_prior_logical_decisions"], [])
        bast_candidate = self.logical_candidate(state, [{"kind": "inner", "motive": "Защищаю Беала от очередного спора.",
            "emotion": "усталость"}, {"kind": "action", "status": "performed", "action": "Закатываю глаза и слегка кривлю лицо.",
            "intensity": "слегка", "audience": ["hero", "bast", "marcus"]}])
        self.logical_accept(state, bast_candidate, next_actor=None)
        ctx.finish_live_session(state)
        formatter = ctx.build_logical_formatter_input(state)
        encoded = json.dumps(formatter["events"], ensure_ascii=False)
        self.assertIn("Не хочу объяснять ему снова", encoded)
        self.assertNotIn("Защищаю Беала от очередного спора", encoded)
        self.assertNotIn("Баст secret", json.dumps(formatter, ensure_ascii=False))
        self.assertEqual(formatter["author_samples"], self.live_fixture()[1]["author_samples"])
        self.assertEqual(formatter["hero_entry_context"], state["bundle"]["role_memory"]["hero"])
        self.assertEqual(formatter["hero_initial_state"], {"position": "near the table", "activity": "listening"})
        self.assertNotIn("near the table", json.dumps(formatter["events"], ensure_ascii=False))
        self.assertEqual(formatter["character_voice_evidence"], state["author_craft"].get("character_voice_evidence", {}))

    def test_logical_v3_writer_plan_preserves_event_ownership_emotion_and_temporal_slots(self):
        state, _ = self.logical_fixture()
        first = self.logical_candidate(state, [
            {"kind": "inner", "motive": "Согласиться на тренировку.",
             "emotion": "настороженность сохраняется, но причин отказывать сейчас не вижу"},
            {"kind": "communication", "recipient": "marcus", "audience": ["hero", "marcus"],
             "content": "Хочу проверить, как сохранять дистанцию при твоих перемещениях.",
             "manner": "ровно", "intensity": "спокойно"}])
        self.logical_accept(state, first, next_actor="marcus")
        npc = self.logical_candidate(state, [
            {"kind": "inner", "motive": "Проверить, смогу ли приблизиться.", "emotion": "интерес"},
            {"kind": "communication", "recipient": "hero", "audience": ["hero", "marcus"],
             "content": "Мне и самому интересно, получится ли к тебе подобраться.",
             "manner": "прямо", "intensity": "с интересом"}])
        self.logical_accept(state, npc, next_actor="hero")
        last = self.logical_candidate(state, [
            {"kind": "inner", "motive": "Начать упражнение.",
             "emotion": "собранный интерес и небольшой азарт; хочется начать двигаться, а не продолжать обсуждение"},
            {"kind": "action", "status": "performed", "action": "Делаю быстрый шаг в сторону.",
             "audience": ["hero", "marcus"], "intensity": "быстро", "position_after": "to the side"},
            {"kind": "communication", "recipient": "marcus", "audience": ["hero", "marcus"],
             "content": "Теперь попробуй приблизиться.", "manner": "приглашающе", "intensity": "собранно"}])
        self.logical_accept(state, last, next_actor=None)
        ctx.finish_live_session(state)

        formatter = ctx.build_logical_formatter_input(state)
        plan = formatter["composition_plan"]
        units = plan["units"]
        self.assertEqual([unit["source_sequence"] for unit in units], sorted(unit["source_sequence"] for unit in units))
        self.assertEqual([unit["source_event"] for unit in units], formatter["events"])
        self.assertEqual([unit["owner_actor_id"] for unit in units], [event["actor_id"] for event in formatter["events"]])
        inner = [unit["source_event"]["decision"] for unit in units if unit["event_kind"] == "inner"]
        self.assertIn("настороженность сохраняется, но причин отказывать сейчас не вижу", [item["emotion"] for item in inner])
        self.assertIn("собранный интерес и небольшой азарт; хочется начать двигаться, а не продолжать обсуждение", [item["emotion"] for item in inner])
        speech = [unit["source_event"]["content"] for unit in units if unit["event_kind"] == "communication"]
        self.assertEqual(speech, [
            "Хочу проверить, как сохранять дистанцию при твоих перемещениях.",
            "Мне и самому интересно, получится ли к тебе подобраться.",
            "Теперь попробуй приблизиться.",
        ])
        self.assertEqual(plan["hero_explicit_state_changes"], [{"source_sequence": 6, "fields": {"position": "to the side"}}])
        self.assertEqual(plan["hero_initial_state"], {"position": "near the table", "activity": "listening"})
        self.assertIn("exact source_sequence", formatter["instruction"])
        self.assertIn("later proposal", formatter["instruction"])
        self.assertIn("mixed attitudes", formatter["instruction"])
        self.assertIn("unchanged posture", formatter["instruction"])
        self.assertIn("one-paragraph-per-unit", formatter["instruction"])
        self.assertNotIn("Проверить, смогу ли приблизиться", json.dumps(plan, ensure_ascii=False))
        self.assertEqual(formatter["composition_plan_sha256"], ctx.canonical_sha256(plan))

        review_input = ctx.build_logical_final_review_input(state, formatter, "Авторский текст сцены.")
        self.assertEqual(review_input["composition_plan_sha256"], formatter["composition_plan_sha256"])
        self.assertIn("actor ownership", review_input["review_dimensions"]["fidelity"])
        self.assertIn("repetitive body-part inventory", review_input["review_dimensions"]["style"])

    def test_logical_v3_leader_external_history_does_not_expand_character_audience(self):
        state, _ = self.logical_fixture(initial_actor="bast")
        candidate = self.logical_candidate(state, [
            {"kind": "inner", "motive": "private NPC reason", "emotion": "private NPC fear"},
            {"kind": "action", "status": "performed", "action": "covert NPC step",
             "position_after": "behind the door", "audience": ["bast"]},
            {"kind": "communication", "recipient": "marcus", "content": "private warning",
             "manner": "quietly", "intensity": "low", "audience": ["bast", "marcus"]}])
        self.logical_accept(state, candidate, next_actor="hero")
        hero_packet = ctx.build_logical_actor_input(state)
        self.assertEqual(hero_packet["host_external_events"], [])
        self.assertNotIn("covert NPC step", json.dumps(hero_packet))
        self.assertNotIn("private warning", json.dumps(hero_packet))
        attempt = self.logical_candidate(state, [{"kind": "action", "status": "attempted",
            "attempt_id": "approach1", "target": "bast", "action": "try approaching NPC",
            "audience": ["hero", "bast"]}])
        self.logical_accept(state, attempt, next_actor="lead")
        packet = ctx.build_logical_actor_input(state)
        self.assertEqual(packet["heard_events"], [])
        external = packet["host_external_events"]
        self.assertEqual([event["kind"] for event in external], ["action", "communication", "action"])
        self.assertEqual(external[0]["action"], "covert NPC step")
        self.assertEqual(external[0]["audience"], ["bast"])
        self.assertEqual(packet["host_pending_attempts"][0]["attempt_id"], "approach1")
        self.assertNotIn("private NPC reason", json.dumps(packet))
        self.assertNotIn("private NPC fear", json.dumps(packet))
        # Detached packet mutation cannot change the accepted history.
        external[0]["action"] = "tampered"
        self.assertEqual(state["transcript"][1]["action"], "covert NPC step")
        self.logical_accept(state, self.logical_candidate(state, []), next_actor=None)
        ctx.finish_live_session(state)
        writer = ctx.build_logical_formatter_input(state)
        self.assertNotIn("host_external_events", writer)
        self.assertNotIn("covert NPC step", json.dumps(writer))
        self.assertNotIn("private warning", json.dumps(writer))
        self.assertNotIn("private NPC reason", json.dumps(writer))

    def test_logical_v3_recorded_pose_is_historical_after_either_resolution_route(self):
        for route in ("actor", "host"):
            with self.subTest(route=route):
                state, _ = self.logical_fixture()
                attempt = self.logical_candidate(state, [
                    {"kind": "action", "status": "performed", "action": "move to the exit",
                     "audience": ["hero", "bast"], "position_after": "beside the exit"},
                    {"kind": "action", "status": "attempted", "attempt_id": "cross1", "target": "door",
                     "action": "try crossing the doorway", "audience": ["hero", "bast"]}])
                self.logical_accept(state, attempt, next_actor="lead")
                resolution = {"kind": "resolution", "attempt_id": "cross1", "outcome": "succeeded",
                    "resolution": "The hero crosses and is now outside.", "audience": ["hero", "bast"]}
                if route == "actor":
                    self.logical_accept(state, self.logical_candidate(state, [resolution]), next_actor="hero")
                else:
                    ctx.resolve_logical_attempt(state, "cross1", outcome=resolution["outcome"],
                        resolution=resolution["resolution"], audience=resolution["audience"])
                    self.logical_accept(state, self.logical_candidate(state, []), next_actor="hero")
                packet = ctx.build_logical_actor_input(state)
                pose = packet["memory"]["own_actor_state"]
                self.assertNotIn("current", pose)
                self.assertEqual(pose["initial"]["position"], "near the table")
                self.assertEqual(pose["last_recorded"]["position"], "beside the exit")
                self.assertEqual(pose["last_recorded_sources"], {
                    "position": {"revision": 1, "sequence": 1}, "activity": {"revision": 0, "sequence": 0}})
                self.assertIn("not a claim of current state", packet["instruction"])
                self.assertEqual(packet["heard_events"][-1]["resolution"], resolution["resolution"])
                # No semantic parsing or invented structured position from resolution prose.
                self.assertEqual(state["logical_current_actor_state"]["hero"]["position"], "beside the exit")

    def test_logical_v3_attempts_need_appended_external_resolution(self):
        state, _ = self.logical_fixture()
        packet = ctx.build_logical_actor_input(state)
        invalid = {"packet_binding": packet["packet_binding"], "response": {"turn": [{
            "kind": "action", "status": "attempted", "attempt_id": "attempt1", "target": "охранник",
            "action": "Пытаюсь пройти.", "audience": ["hero", "lead"], "position_after": "за дверью"}]}}
        with self.assertRaisesRegex(ctx.ContextError, "cannot update position or activity"):
            ctx.validate_logical_response(state, invalid)
        attempt = self.logical_candidate(state, [
            {"kind": "action", "status": "performed", "action": "Отхожу от стола к свободному выходу.",
             "audience": ["hero", "lead"], "position_after": "beside the exit", "activity_after": "trying to leave"},
            {"kind": "action", "status": "attempted", "attempt_id": "attempt1",
             "target": "охранник у выхода", "action": "Пытаюсь пройти мимо охранника.",
             "audience": ["hero", "lead"]}])
        original = json.loads(json.dumps(attempt["turn"][1], ensure_ascii=False))
        self.logical_accept(state, attempt, next_actor="lead")
        self.assertEqual(state["logical_current_actor_state"]["hero"],
                         {"position": "beside the exit", "activity": "trying to leave"})
        with self.assertRaisesRegex(ctx.ContextError, "cannot resolve its own"):
            ctx.resolve_logical_attempt(state, "attempt1", outcome="succeeded", resolution="Успех.",
                                        audience=["hero", "lead"], resolver_actor_id="hero")
        with self.assertRaisesRegex(ctx.ContextError, "NPC can resolve only an attempt it perceived"):
            ctx.resolve_logical_attempt(state, "attempt1", outcome="succeeded", resolution="Успех.",
                                        audience=["bast", "lead"], resolver_actor_id="bast")
        leader_packet = ctx.build_logical_actor_input(state)
        self.assertEqual(leader_packet["host_pending_attempts"][0]["attempt_id"], "attempt1")
        before_revision = state["revision"]
        lead = self.logical_candidate(state, [
            {"kind": "resolution", "attempt_id": "attempt1", "outcome": "blocked",
             "resolution": "Охранник перекрывает выход.", "audience": ["hero", "lead", "bast"]},
            {"kind": "action", "status": "performed", "action": "Охранник остается у выхода.",
             "audience": ["hero", "lead", "marcus", "bast"]}])
        self.logical_accept(state, lead, next_actor="bast")
        self.assertEqual(state["revision"], before_revision + 1)
        self.assertEqual(state["transcript"][1]["action"], original["action"])
        self.assertEqual(state["transcript"][1]["status"], "attempted")
        self.assertEqual(state["transcript"][2]["attempt_id"], "attempt1")
        self.assertEqual(state["transcript"][2]["outcome"], "blocked")
        bast_packet = ctx.build_logical_actor_input(state)
        self.assertNotIn("attempt1", json.dumps(bast_packet["heard_events"], ensure_ascii=False))
        self.assertNotIn("Пытаюсь пройти мимо охранника", json.dumps(bast_packet["heard_events"], ensure_ascii=False))
        self.assertIn("Охранник перекрывает выход", json.dumps(bast_packet["heard_events"], ensure_ascii=False))
        with self.assertRaisesRegex(ctx.ContextError, "already has a resolution"):
            self.logical_candidate(state, [{"kind": "resolution", "attempt_id": "attempt1", "outcome": "failed",
                "resolution": "Еще один исход.", "audience": ["bast", "hero"]}])
        with self.assertRaisesRegex(ctx.ContextError, "logical candidate hash is invalid"):
            ctx.logical_continuation_binding(state, lead)
        with self.assertRaisesRegex(ctx.ContextError, "host-selected current actor"):
            ctx.build_logical_actor_input(state, "hero")
        self.assertEqual(state["transcript"][2]["outcome"], "blocked")
        bast_silence = self.logical_candidate(state, [])
        self.logical_accept(state, bast_silence, next_actor=None)
        ctx.finish_live_session(state)
        self.assertEqual([e["kind"] for e in state["transcript"]], ["action", "action", "resolution", "action"])

        pending, _ = self.logical_fixture()
        pending_attempt = self.logical_candidate(pending, [{"kind": "action", "status": "attempted",
            "attempt_id": "attempt2", "target": "закрытая дверь", "action": "Пробую открыть дверь.",
            "audience": ["hero", "lead"]}])
        self.logical_accept(pending, pending_attempt, next_actor="lead")
        leader_silence = self.logical_candidate(pending, [])
        self.logical_accept(pending, leader_silence, next_actor=None)
        ctx.finish_live_session(pending)
        pending_formatter = ctx.build_logical_formatter_input(pending)
        attempt_event = next(e for e in pending_formatter["events"] if e.get("attempt_id") == "attempt2")
        self.assertEqual(attempt_event["status"], "attempted")
        self.assertNotIn("outcome", attempt_event)

        hidden, _ = self.logical_fixture(initial_actor="bast")
        hidden_attempt = self.logical_candidate(hidden, [{"kind": "action", "status": "attempted",
            "attempt_id": "hiddenattempt", "target": "закрытая ниша", "action": "Проверяю нишу за панелью.",
            "audience": ["bast", "lead"]}])
        self.logical_accept(hidden, hidden_attempt, next_actor="lead")
        lead_response = self.logical_candidate(hidden, [{"kind": "resolution", "attempt_id": "hiddenattempt",
            "outcome": "blocked", "resolution": "Панель не сдвинулась.", "audience": ["hero", "lead"]}])
        self.logical_accept(hidden, lead_response, next_actor="hero")
        hero_packet = ctx.build_logical_actor_input(hidden)
        self.assertNotIn("hiddenattempt", json.dumps(hero_packet["heard_events"], ensure_ascii=False))
        self.assertNotIn("Проверяю нишу", json.dumps(hero_packet["heard_events"], ensure_ascii=False))
        self.assertIn("Панель не сдвинулась", json.dumps(hero_packet["heard_events"], ensure_ascii=False))
        hero_silence = self.logical_candidate(hidden, [])
        self.logical_accept(hidden, hero_silence, next_actor=None)
        ctx.finish_live_session(hidden)
        hidden_formatter = ctx.build_logical_formatter_input(hidden)
        self.assertNotIn("hiddenattempt", json.dumps(hidden_formatter["events"], ensure_ascii=False))
        self.assertNotIn("Проверяю нишу", json.dumps(hidden_formatter["events"], ensure_ascii=False))
        self.assertIn("Панель не сдвинулась", json.dumps(hidden_formatter["events"], ensure_ascii=False))

        own_attempt, _ = self.logical_fixture(initial_actor="bast")
        npc_attempt = self.logical_candidate(own_attempt, [{"kind": "action", "status": "attempted",
            "attempt_id": "npcattempt", "target": "запертая дверь", "action": "Пробую повернуть ручку.",
            "audience": ["bast", "hero", "lead"]}])
        self.logical_accept(own_attempt, npc_attempt, next_actor="bast")
        own_packet = ctx.build_logical_actor_input(own_attempt)
        with self.assertRaisesRegex(ctx.ContextError, "initiating actor cannot resolve"):
            ctx.validate_logical_response(own_attempt, {"packet_binding": own_packet["packet_binding"], "response": {"turn": [
                {"kind": "resolution", "attempt_id": "npcattempt", "outcome": "succeeded",
                 "resolution": "Дверь открылась.", "audience": ["bast", "hero"]}]}})

    def test_logical_v3_rejects_stale_reviews_and_requires_independent_prose_assessments(self):
        state, _ = self.logical_fixture()
        packet = ctx.build_logical_actor_input(state)
        stale = dict(packet["packet_binding"])
        stale["based_on_revision"] = 99
        with self.assertRaisesRegex(ctx.ContextError, "stale or mismatched"):
            ctx.validate_logical_response(state, {"packet_binding": stale, "response": {"turn": []}})
        tampered_state, _ = self.logical_fixture()
        tampered_state["logical_current_actor_state"]["hero"]["position"] = "tampered offstage location"
        with self.assertRaisesRegex(ctx.ContextError, "outside accepted own-action updates"):
            ctx.build_logical_actor_input(tampered_state)
        tampered_initial, _ = self.logical_fixture()
        tampered_initial["logical_initial_actor_state"]["hero"]["position"] = "tampered entry position"
        with self.assertRaisesRegex(ctx.ContextError, "initial actor state changed"):
            ctx.build_logical_actor_input(tampered_initial)
        candidate = self.logical_candidate(state, [{"kind": "action", "status": "performed",
            "action": "Я убираю руку со стола.", "audience": ["hero", "bast", "marcus"]}])
        wrong_review = {"verdict": "continue", "issues": [], "binding": {**ctx.logical_continuation_binding(state, candidate), "candidate_sha256": "0"*64}}
        with self.assertRaisesRegex(ctx.ContextError, "exact candidate"):
            ctx.accept_logical_response(state, candidate, continuation_review=wrong_review, next_actor=None)
        self.logical_accept(state, candidate, next_actor=None)
        ctx.finish_live_session(state)
        formatter = ctx.build_logical_formatter_input(state)
        with self.assertRaisesRegex(ctx.ContextError, "byte-equal"):
            review_input = ctx.build_logical_final_review_input(state, formatter, "Я убираю руку со стола.")
            binding = {key: review_input[key] for key in ("session_id", "source_fingerprint", "transcript_sha256", "skeleton_sha256", "projection_sha256", "composition_plan_sha256", "writer_input_sha256", "prose_sha256")}
            ctx.validate_logical_prose(state, formatter, "Я убираю руку со стола.", final_review={
                "fidelity": "pass", "style": "pass", "issues": [], "binding": binding})
        prose = "Рука сошла с края стола. Я следил за дверью, не решаясь отвернуться."
        review_input = ctx.build_logical_final_review_input(state, formatter, prose)
        binding = {key: review_input[key] for key in ("session_id", "source_fingerprint", "transcript_sha256", "skeleton_sha256", "projection_sha256", "composition_plan_sha256", "writer_input_sha256", "prose_sha256")}
        review = {"fidelity": "pass", "style": "pass", "issues": [], "binding": binding}
        self.assertTrue(ctx.validate_logical_prose(state, formatter, prose, final_review=review)["accepted"])
        style_revision = {**review, "style": "revise"}
        self.assertFalse(ctx.validate_logical_prose(state, formatter, prose, final_review=style_revision)["accepted"])
        stale_binding = {**binding, "skeleton_sha256": "0"*64}
        with self.assertRaisesRegex(ctx.ContextError, "bind actual prose and full skeleton"):
            ctx.validate_logical_prose(state, formatter, prose, final_review={**review, "binding": stale_binding})

    def test_logical_writer_realization_keeps_strong_gesture_and_renewed_reaction(self):
        state, _ = self.logical_fixture()
        candidate = self.logical_candidate(state, [
            {"kind": "inner", "motive": "Выразить несогласие.", "emotion": "сильное недовольство, но без злости"},
            {"kind": "action", "status": "performed", "action": "Экспрессивно жестикулирую руками.",
             "attention": "Баст", "intensity": "очень выразительно", "audience": ["hero", "bast"]},
            {"kind": "communication", "recipient": "bast", "audience": ["hero", "bast"],
             "content": "Не согласен с решением.", "manner": "возмущённо", "intensity": "громко"},
            {"kind": "inner", "motive": "Не уступать.", "emotion": "сильное недовольство, но без злости"},
            {"kind": "action", "status": "performed", "action": "Делаю шаг от стола.",
             "intensity": "резко", "position_after": "в шаге от стола", "audience": ["hero", "bast"]},
            {"kind": "inner", "motive": "Услышать ответ.", "emotion": "недовольство ослабло, появилась настороженность"}])
        self.logical_accept(state, candidate, next_actor=None)
        ctx.finish_live_session(state)
        snapshot = json.loads(json.dumps(state))
        writer = ctx.build_logical_formatter_input(state)
        self.assertEqual(state, snapshot, "Presentation must never rewrite role decisions")
        self.assertEqual([u["source_event"] for u in writer["composition_plan"]["units"]], writer["events"])
        inner = [u["source_event"]["decision"]["emotion"] for u in writer["composition_plan"]["units"] if u["event_kind"] == "inner"]
        self.assertEqual(inner, ["сильное недовольство, но без злости", "сильное недовольство, но без злости", "недовольство ослабло, появилась настороженность"])
        gesture = writer["composition_plan"]["units"][1]
        self.assertEqual(gesture["source_event"]["action"], "Экспрессивно жестикулирую руками.")
        self.assertEqual(gesture["source_event"]["intensity"], "очень выразительно")
        step = writer["composition_plan"]["units"][4]
        self.assertIn("position_after", step["continuity_fields"])
        self.assertIn("action", step["semantic_fields"])
        self.assertEqual(writer["composition_plan"]["rendering_contract"]["version"], 3)

    def test_writer_explicit_setup_and_resolution_guards_never_rewrite_source(self):
        state, _ = self.logical_fixture(initial_actor="lead")
        self.logical_accept(state, self.logical_candidate(state, [{"kind": "action", "status": "performed",
            "action": "Начальная обстановка: дверь закрыта, стол стоит рядом.", "attention": "дверь", "intensity": "без дополнительных явлений", "audience": ["hero", "bast"]}]), next_actor="hero")
        self.logical_accept(state, self.logical_candidate(state, [{"kind": "action", "status": "attempted",
            "action": "Пытаюсь открыть дверь.", "attempt_id": "open1", "target": "дверь", "audience": ["hero", "bast"]}]), next_actor="lead")
        text = "Дверь открыта. Стол не сдвинут."
        self.logical_accept(state, self.logical_candidate(state, [{"kind": "resolution", "attempt_id": "open1",
            "outcome": "succeeded", "resolution": text, "audience": ["hero", "bast"]}]), next_actor=None)
        ctx.finish_live_session(state)
        original = ctx.build_logical_formatter_input(state)
        setup, action, resolution = original["events"]
        cut = text.index("Стол")
        annotations = [
            {"source_sequence": setup["sequence"], "source_event_sha256": ctx.canonical_sha256(setup), "presentation_role": "scene_setup"},
            {"source_sequence": resolution["sequence"], "source_event_sha256": ctx.canonical_sha256(resolution), "presentation_role": "resolved_effect", "parts": [
                {"start": 0, "end": cut, "use": "changed_effect"}, {"start": cut, "end": len(text), "use": "continuity_guard"}]}]
        formatted = ctx.build_logical_formatter_input(state, presentation_annotations=annotations)
        units = formatted["composition_plan"]["units"]
        self.assertEqual(formatted["events"], original["events"])
        self.assertEqual(formatted["transcript_sha256"], original["transcript_sha256"])
        self.assertEqual(units[0]["semantic_fields"], [])
        self.assertIn("action", units[0]["continuity_fields"])
        self.assertIn("action", units[1]["semantic_fields"])
        self.assertEqual(units[2]["semantic_fields"], ["outcome"])
        self.assertEqual(units[2]["required_effects"][0]["text"], "Дверь открыта. ")
        self.assertEqual(units[2]["continuity_guards"][0]["text"], "Стол не сдвинут.")
        compact = ctx.build_logical_writer_generation_input(state, formatted)
        self.assertEqual(compact["context"]["staging"][0]["context"], setup["action"])
        self.assertEqual(compact["context"]["staging"][0]["qualifiers"], {"attention": "дверь", "intensity": "без дополнительных явлений"})
        acts = [o["act"] for i in compact["interactions"] for o in i["before_reply"] + [i["reply"]]] + [o["act"] for o in compact["closing_actions"]]
        self.assertEqual([a["source_sequence"] for a in acts], [action["sequence"], resolution["sequence"]])
        self.assertEqual(acts[-1]["fields"]["changed_effects"], units[2]["required_effects"])
        self.assertNotIn("resolution", acts[-1]["fields"])
        self.assertEqual(compact["constraints"][-1]["unchanged_guards"], units[2]["continuity_guards"])
        ctx.build_logical_final_review_input(state, formatted, "Пробная проза.", generation_input=compact)
        for change in ["new_field", "unknown_kind"]:
            unknown = json.loads(json.dumps(formatted))
            event = unknown["composition_plan"]["units"][1]["source_event"]
            if change == "new_field": event["new_behavior"] = "must not vanish"
            else: event["kind"] = "new_kind"
            with patch.object(ctx, "build_logical_formatter_input", return_value=unknown):
                with self.assertRaisesRegex(ctx.ContextError, "explicit compact projection"):
                    ctx.build_logical_writer_generation_input(state, unknown)


        for delta in [
            {"source_event_sha256": "0" * 64},
            {"parts": [{"start": 0, "end": len(text), "use": "continuity_guard"}]},
            {"parts": [{"start": 1, "end": len(text), "use": "changed_effect"}]},
        ]:
            bad = [annotations[0], {**annotations[1], **delta}]
            with self.assertRaises(ctx.ContextError):
                ctx.build_logical_formatter_input(state, presentation_annotations=bad)
        with self.assertRaisesRegex(ctx.ContextError, "only performed leader"):
            ctx.build_logical_formatter_input(state, presentation_annotations=[{"source_sequence": action["sequence"], "source_event_sha256": ctx.canonical_sha256(action), "presentation_role": "scene_setup"}])

    def test_logical_final_review_covers_voice_and_rejects_instruction_only_change(self):
        state, _ = self.logical_fixture()
        self.logical_accept(state, self.logical_candidate(state, [{"kind": "action", "status": "performed",
            "action": "Убираю ладонь со стола.", "audience": ["hero", "bast"]}]), next_actor=None)
        ctx.finish_live_session(state)
        writer = ctx.build_logical_formatter_input(state)
        prose = "Ладонь скользнула с края стола."
        before = ctx.build_logical_final_review_input(state, writer, prose)
        for field in ["formatter_guidance", "author_samples", "character_voice_evidence"]:
            self.assertEqual(before[field], writer[field])
        self.assertEqual(before["writer_instruction"], writer["instruction"])
        self.assertEqual(before["writer_input_sha256"], ctx.canonical_sha256(writer))
        keys = ("session_id", "source_fingerprint", "transcript_sha256", "skeleton_sha256", "projection_sha256", "composition_plan_sha256", "writer_input_sha256", "prose_sha256")
        review = {"fidelity": "pass", "style": "pass", "issues": [], "binding": {k: before[k] for k in keys}}
        with patch.object(ctx, "_LOGICAL_WRITER_INSTRUCTION", writer["instruction"] + " Changed delivery instruction."):
            changed = ctx.build_logical_formatter_input(state)
            after = ctx.build_logical_final_review_input(state, changed, prose)
            for key in keys:
                if key != "writer_input_sha256":
                    self.assertEqual(before[key], after[key], "Existing bindings alone miss instruction-only changes")
            self.assertNotEqual(before["writer_input_sha256"], after["writer_input_sha256"])
            with self.assertRaisesRegex(ctx.ContextError, "bind actual prose and full skeleton"):
                ctx.validate_logical_prose(state, changed, prose, final_review=review)

    def test_compact_writer_has_one_complete_stream_and_preserves_turn_boundaries(self):
        state, _ = self.logical_fixture()
        self.logical_accept(state, self.logical_candidate(state, [
            {"kind": "inner", "motive": "Добиться ответа.", "emotion": "сильное недовольство, но без злости"},
            {"kind": "action", "status": "performed", "action": "Экспрессивно жестикулирую руками.", "intensity": "очень выразительно", "audience": ["hero", "bast"]},
            {"kind": "communication", "recipient": "bast", "audience": ["hero", "bast"], "content": "Прошу объяснить решение.", "manner": "настойчиво", "intensity": "громко", "literal_terms": ["решение"]}]), next_actor="bast")
        self.logical_accept(state, self.logical_candidate(state, [
            {"kind": "inner", "motive": "NPC_PRIVATE_MOTIVE", "emotion": "NPC_PRIVATE_FEELING"},
            {"kind": "communication", "recipient": "hero", "audience": ["hero", "bast"], "content": "Конкретный ответ.", "manner": "прямо", "intensity": "негромко"}]), next_actor="hero")
        self.logical_accept(state, self.logical_candidate(state, [
            {"kind": "inner", "motive": "Уточнить ответ.", "emotion": "настороженность появилась вместо недовольства"}]), next_actor=None)
        ctx.finish_live_session(state)
        before = json.loads(json.dumps(state))
        full = ctx.build_logical_formatter_input(state)
        clean = ctx.build_logical_writer_generation_input(state, full)
        self.assertEqual(state, before)
        self.assertNotIn("events", clean)
        self.assertNotIn("composition_plan", clean)
        self.assertNotIn("draft", clean)
        self.assertNotIn('"source_event":', json.dumps(clean))
        self.assertNotIn("NPC_PRIVATE", json.dumps(clean))
        self.assertTrue(all(set(spec) == {"name", "role"} for spec in clean["participants"].values()))
        owned = [o for i in clean["interactions"] for o in i["before_reply"] + [i["reply"]]] + clean["closing_actions"]
        self.assertEqual([i["reply"]["owner"]["actor_id"] for i in clean["interactions"]], ["hero", "bast"])
        self.assertEqual(clean["closing_actions"][0]["owner"]["actor_id"], "hero")
        acts = [o["act"] for o in owned]
        self.assertEqual([a["source_sequence"] for a in acts], [e["sequence"] for e in full["events"]])
        self.assertEqual(acts[1]["fields"]["action"], "Экспрессивно жестикулирую руками.")
        self.assertEqual(acts[1]["fields"]["intensity"], "очень выразительно")
        self.assertEqual(acts[2]["fields"]["literal_terms"], ["решение"])
        self.assertEqual(acts[0]["fields"]["decision"]["emotion"], "сильное недовольство, но без злости")
        self.assertEqual(acts[-1]["fields"]["decision"]["emotion"], "настороженность появилась вместо недовольства")
        for change in ["remove", "reorder", "owner", "value", "source"]:
            bad = json.loads(json.dumps(clean))
            if change == "remove": bad["interactions"][0]["before_reply"].pop()
            if change == "reorder": bad["interactions"][0]["before_reply"].reverse()
            if change == "owner": bad["interactions"][0]["reply"]["owner"]["actor_id"] = "bast"
            if change == "value": bad["interactions"][0]["before_reply"][1]["act"]["fields"]["intensity"] = "слабо"
            if change == "source": bad["interactions"][0]["before_reply"][1]["act"]["source_sequence"] = 999
            with self.assertRaisesRegex(ctx.ContextError, "lost, reordered or changed"):
                ctx.build_logical_final_review_input(state, full, "Фактический текст.", generation_input=bad)

    def test_compact_speech_execution_is_same_owner_actual_time_and_single_anchor(self):
        state, _ = self.logical_fixture()
        self.logical_accept(state, self.logical_candidate(state, [
            {"kind": "action", "status": "performed", "action": "Поднимаю руку.", "intensity": "резко", "audience": ["hero", "bast"]},
            {"kind": "communication", "recipient": "bast", "audience": ["hero", "bast"], "content": "Возражаю.", "manner": "настойчиво", "intensity": "громко"},
            {"kind": "action", "status": "performed", "action": "Отхожу от стола.", "audience": ["hero", "bast"]}]), next_actor="bast")
        self.logical_accept(state, self.logical_candidate(state, [
            {"kind": "communication", "recipient": "hero", "audience": ["hero", "bast"], "content": "Отвечаю по существу.", "manner": "спокойно", "intensity": "негромко"}]), next_actor=None)
        ctx.finish_live_session(state)
        full = ctx.build_logical_formatter_input(state)
        clean = ctx.build_logical_writer_generation_input(state, full)
        first, second = clean["interactions"]
        self.assertEqual(first["speech_execution"]["before"][0]["source_sequence"], 1)
        self.assertEqual(first["speech_execution"]["after"][0]["source_sequence"], 3)
        self.assertEqual(second["speech_execution"], {"before": [], "after": []}, "Bast cannot inherit Beal's movement")
        owned = [o for i in clean["interactions"] for o in i["before_reply"] + [i["reply"]]] + clean["closing_actions"]
        self.assertEqual([o["act"]["source_sequence"] for o in owned], [1, 2, 3, 4])
        refs = [r for i in clean["interactions"] for side in ("before", "after") for r in i["speech_execution"][side]]
        self.assertEqual(len(refs), len({r["source_sequence"] for r in refs}))
        bad = json.loads(json.dumps(clean));bad["interactions"][1]["speech_execution"]["before"] = first["speech_execution"]["after"]
        with self.assertRaises(ctx.ContextError):
            ctx.build_logical_final_review_input(state, full, "Текст.", generation_input=bad)

    def test_compact_voice_directives_are_review_bound_and_default_route_unchanged(self):
        state, _ = self.logical_fixture()
        self.logical_accept(state, self.logical_candidate(state, [{"kind": "action", "status": "performed", "action": "Делаю шаг.", "audience": ["hero", "bast"]}]), next_actor=None)
        ctx.finish_live_session(state)
        full = ctx.build_logical_formatter_input(state)
        directives = [{"provenance": "author correction", "scope": "voice only", "text": "Связывать реплику с выбранным исполнением."}]
        clean = ctx.build_logical_writer_generation_input(state, full, author_directives=directives)
        prose = "Пробный текст, не автоматическая оценка стиля."
        legacy = ctx.build_logical_final_review_input(state, full, prose)
        self.assertNotIn("compact_input_sha256", legacy)
        self.assertNotIn("generation_input", legacy)
        audited = ctx.build_logical_final_review_input(state, full, prose, generation_input=clean)
        self.assertEqual(audited["compact_input_sha256"], ctx.canonical_sha256(clean))
        keys = ("session_id", "source_fingerprint", "transcript_sha256", "skeleton_sha256", "projection_sha256", "composition_plan_sha256", "writer_input_sha256", "prose_sha256", "compact_input_sha256")
        review = {"fidelity": "pass", "style": "pass", "issues": [], "binding": {k: audited[k] for k in keys}}
        self.assertTrue(ctx.validate_logical_prose(state, full, prose, final_review=review, generation_input=clean)["accepted"])
        changed = ctx.build_logical_writer_generation_input(state, full, author_directives=[{**directives[0], "text": "Изменённая авторская дельта."}])
        with self.assertRaisesRegex(ctx.ContextError, "bind actual prose and full skeleton"):
            ctx.validate_logical_prose(state, full, prose, final_review=review, generation_input=changed)


    def semantic_fixture(self):
        state, _ = self.logical_fixture()
        self.logical_accept(state, self.logical_candidate(state, [
            {"kind": "inner", "motive": "Хочу добиться ответа.", "emotion": "Сильное недовольство, но без злости."},
            {"kind": "action", "status": "performed", "action": "Я экспрессивно жестикулирую руками.", "attention": "Баст", "intensity": "Очень выразительно", "audience": ["hero", "bast"]},
            {"kind": "communication", "recipient": "bast", "audience": ["hero", "bast"], "content": "Выражаю несогласие.", "manner": "Настойчиво", "intensity": "Громко"}]), next_actor=None)
        ctx.finish_live_session(state)
        full = ctx.build_logical_formatter_input(state)
        base = ctx.build_logical_writer_generation_input(state, full)
        details = {"decision.motive": {"цель": "получить ответ"}, "decision.emotion": {"недовольство": "сильное", "злость": False},
            "action": {"движение": "жестикуляция", "часть_тела": "руки", "характер": "экспрессивный"},
            "attention": {"объект": "bast"}, "content": {"позиция": "несогласие"}, "manner": {"подача": "настойчивая"}}
        entries = {}
        for slot in ctx._logical_semantic_slots(base):
            value = details.get(slot["field"], {"степень": "очень выразительная" if slot["source_sequence"] == 2 else "высокая громкость"})
            entry = entries.setdefault(slot["source_sequence"], {"source_sequence": slot["source_sequence"], "source_event_sha256": slot["source_event_sha256"], "fields": []})
            entry["fields"].append({"field": slot["field"], "parts": [{"start": 0, "end": len(slot["value"]), "components": [{"relation": slot["field"], "details": value}]}]})
        return state, full, {"schema": "logical-semantic-manifest-v1", "entries": list(entries.values())}

    def test_semantic_writer_preserves_complete_gesture_and_uses_other_hero_pov(self):
        state, full, manifest = self.semantic_fixture()
        before = json.dumps(state, ensure_ascii=False, sort_keys=True)
        candidate = ctx.build_logical_semantic_writer_candidate(state, full, manifest)
        self.assertIn(full["viewpoint"]["character"], candidate["instruction"])
        self.assertNotIn("Пелун", candidate["instruction"])
        self.assertNotIn("завершённое предшествование", candidate["instruction"])
        self.assertIn("не назначают ремарку", candidate["instruction"])
        self.assertNotIn("Я экспрессивно жестикулирую руками.", json.dumps(candidate, ensure_ascii=False))
        owned = [o for i in candidate["interactions"] for o in i["before_reply"] + [i["reply"]]] + candidate["closing_actions"]
        gesture = owned[1]["act"]["fields"]
        self.assertEqual(gesture["action"]["components"][0]["details"], {"движение": "жестикуляция", "часть_тела": "руки", "характер": "экспрессивный"})
        self.assertEqual(gesture["intensity"]["components"][0]["details"]["степень"], "очень выразительная")
        self.assertFalse(owned[0]["act"]["fields"]["decision"]["emotion"]["components"][0]["details"]["злость"])
        self.assertEqual(json.dumps(state, ensure_ascii=False, sort_keys=True), before)
        self.assertNotIn("semantic_review", candidate, "A candidate is not a semantic acceptance")

    def test_semantic_manifest_rejects_incomplete_stale_or_malformed_mapping(self):
        state, full, manifest = self.semantic_fixture()
        for change in ["missing_event", "missing_field", "stale", "gap", "empty", "extra"]:
            bad = json.loads(json.dumps(manifest))
            if change == "missing_event": bad["entries"].pop()
            if change == "missing_field": bad["entries"][0]["fields"].pop()
            if change == "stale": bad["entries"][0]["source_event_sha256"] = "0" * 64
            if change == "gap": bad["entries"][0]["fields"][0]["parts"][0]["start"] = 1
            if change == "empty": bad["entries"][0]["fields"][0]["parts"][0]["components"] = []
            if change == "extra": bad["entries"][0]["fields"].append(bad["entries"][0]["fields"][0])
            with self.subTest(change=change), self.assertRaises(ctx.ContextError):
                ctx.build_logical_semantic_writer_candidate(state, full, bad)

    def test_semantic_preflight_and_final_review_bind_exact_meaning_and_packet(self):
        state, full, manifest = self.semantic_fixture()
        candidate = ctx.build_logical_semantic_writer_candidate(state, full, manifest)
        # A synthetic certificate checks binding only; it is never proof of literary quality.
        review = {"verdict": "pass", "issues": [], "binding": ctx.logical_semantic_review_binding(full, manifest, candidate)}
        with self.assertRaises(ctx.ContextError):
            ctx.build_logical_semantic_writer_input(state, full, manifest, semantic_review={**review, "verdict": "revise"})
        ready = ctx.build_logical_semantic_writer_input(state, full, manifest, semantic_review=review)
        final = ctx.build_logical_final_review_input(state, full, "Пробный текст.", generation_input=ready, semantic_manifest=manifest)
        self.assertEqual(final["compact_input_sha256"], ctx.canonical_sha256(ready))
        with self.assertRaises(ctx.ContextError):
            ctx.build_logical_final_review_input(state, full, "Пробный текст.", generation_input=ready)
        changed = json.loads(json.dumps(manifest));changed["entries"][0]["fields"][0]["parts"][0]["components"][0]["details"] = {"злость": True}
        with self.assertRaises(ctx.ContextError):
            ctx.build_logical_semantic_writer_input(state, full, changed, semantic_review=review)
        bad = json.loads(json.dumps(ready));bad["interactions"][0]["reply"]["owner"]["actor_id"] = "bast"
        with self.assertRaises(ctx.ContextError):
            ctx.build_logical_final_review_input(state, full, "Пробный текст.", generation_input=bad, semantic_manifest=manifest)


    def grounded_fixture(self, initial_actor="hero"):
        legacy, guidance = self.logical_fixture(initial_actor=initial_actor)
        frames = {}
        for actor, spec in legacy["actors"].items():
            if spec["role"] != "leader":
                frames[actor] = {"current_goal": "Вернуться к занятиям" if actor == "hero" else "Подготовить овощи",
                    "strivings": ["Продвинуться в учёбе" if actor == "hero" else "Подготовить еду к готовке"],
                    "grounds": [{"id": "entry", "text": "Герой пришёл вернуть миску и намерен вернуться к занятиям." if actor == "hero" else "Нужно подготовить овощи; собственная работа ещё не сделана.",
                                 "provenance": "Explicit test scene staging"}]}
        return ctx.initialize_logical_session(legacy["bundle"], hero_name=legacy["hero_name"], actors=legacy["actors"],
            author_craft=legacy["author_craft"], actor_guidance=guidance, initial_actor=initial_actor,
            motivation_frames=frames, scene_motivation_context={"author_only": "AUTHOR_PROBLEM_NOT_NPC_KNOWLEDGE"},
            scene_purpose={"functions": ["Развитие"], "why": "Проверить выбор способа учиться.",
                "entry_state": "Герой следует прежней практике.", "intended_shift": "Проверит новую возможность, если она окажется уместна.",
                "open_outcomes": ["Уточнит возможность", "Осознанно сохранит прежний способ"]})

    def grounded_review(self, state, candidate):
        actor = candidate["actor_id"]
        packet = ctx.build_logical_motivation_review_input(state, candidate)
        return {"verdict": "continue", "issues": [], "binding": packet["binding"], "motivation": {
            "goal_relation": "continue", "next_goal": packet["current_goal"],
            "transition_reason": "Действие продолжает ранее выбранную цель, не меняя её приоритет.",
            "trigger_refs": [], "decision_basis": [{"items": list(range(len(candidate["turn"]))),
                "grounds": [{"ref": "ground:entry", "quote": state["logical_motivation_frames"][actor]["grounds"][0]["text"]}],
                "reason": "Ранее установленная задача остаётся основанием конкретного действия."}]}}

    def test_new_logical_init_rejects_missing_motivation_instead_of_silent_legacy(self):
        old, guidance = self.logical_fixture()
        with self.assertRaisesRegex(ctx.ContextError, "require source-grounded"):
            ctx.initialize_logical_session(old["bundle"], hero_name=old["hero_name"], actors=old["actors"],
                author_craft=old["author_craft"], actor_guidance=guidance, initial_actor="hero")

    def test_grounded_packets_keep_character_and_author_context_separate(self):
        state = self.grounded_fixture()
        hero = ctx.build_logical_actor_input(state)
        self.assertEqual(hero["motivation_context"]["current_goal"], "Вернуться к занятиям")
        self.assertNotIn("AUTHOR_PROBLEM_NOT_NPC_KNOWLEDGE", json.dumps(hero))
        self.assertNotIn("Подготовить овощи", json.dumps(hero["motivation_context"], ensure_ascii=False))
        lead = self.grounded_fixture("lead")
        self.assertIn("AUTHOR_PROBLEM_NOT_NPC_KNOWLEDGE", json.dumps(ctx.build_logical_actor_input(lead)))
        npc = self.grounded_fixture("bast")
        self.assertNotIn("AUTHOR_PROBLEM_NOT_NPC_KNOWLEDGE", json.dumps(ctx.build_logical_actor_input(npc)))

    def test_grounded_turn_requires_more_than_continue_and_motive_string(self):
        state = self.grounded_fixture()
        candidate = self.logical_candidate(state, [{"kind": "inner", "motive": "Хочу передышку", "emotion": "Ручная работа приятна"}])
        before = json.loads(json.dumps(state))
        with self.assertRaisesRegex(ctx.ContextError, "continuation review"):
            self.logical_accept(state, candidate)
        self.assertEqual(state, before)

    def test_goal_change_cannot_hide_as_continue_or_have_no_trigger(self):
        state = self.grounded_fixture()
        candidate = self.logical_candidate(state, [{"kind": "inner", "motive": "Помочь повару вместо занятий", "emotion": "Интерес"}])
        review = self.grounded_review(state, candidate)
        review["motivation"]["next_goal"] = "Перебирать овощи"
        with self.assertRaisesRegex(ctx.ContextError, "changed goal"):
            self.logical_accept(state, candidate, review=review)
        review["motivation"]["goal_relation"] = "change"
        with self.assertRaisesRegex(ctx.ContextError, "grounded trigger"):
            self.logical_accept(state, candidate, review=review)

    def test_candidate_feeling_cannot_be_quoted_as_its_own_prior_basis(self):
        state = self.grounded_fixture()
        candidate = self.logical_candidate(state, [{"kind": "inner", "motive": "Хочу передышку", "emotion": "Ручная работа приятна"}])
        review = self.grounded_review(state, candidate)
        review["motivation"]["decision_basis"][0]["grounds"] = [{"ref": "candidate:0", "quote": "Хочу передышку"}]
        with self.assertRaisesRegex(ctx.ContextError, "not its own proof"):
            self.logical_accept(state, candidate, review=review)

    def test_review_requires_every_decision_and_exact_available_quotes(self):
        state = self.grounded_fixture()
        candidate = self.logical_candidate(state, [{"kind": "inner", "motive": "Вернуться к занятиям", "emotion": "Спокоен"},
            {"kind": "communication", "recipient": "bast", "audience": ["hero", "bast"], "content": "Отказывается задержаться ради занятий", "manner": "Прямо", "intensity": "Сдержанно"}])
        review = self.grounded_review(state, candidate)
        review["motivation"]["decision_basis"][0]["items"] = [0]
        with self.assertRaisesRegex(ctx.ContextError, "every decision"):
            self.logical_accept(state, candidate, review=review)
        review = self.grounded_review(state, candidate)
        review["motivation"]["decision_basis"][0]["grounds"][0]["quote"] = "Он устал от занятий"
        with self.assertRaisesRegex(ctx.ContextError, "quote must match"):
            self.logical_accept(state, candidate, review=review)

    def test_private_npc_inner_cannot_ground_hero_change(self):
        state = self.grounded_fixture("bast")
        candidate = self.logical_candidate(state, [{"kind": "inner", "motive": "Не хочу испортить овощи", "emotion": "Сосредоточенность"}])
        self.logical_accept(state, candidate, next_actor="hero", review=self.grounded_review(state, candidate))
        hero = self.logical_candidate(state, [{"kind": "inner", "motive": "Помочь", "emotion": "Интерес"}])
        packet = ctx.build_logical_motivation_review_input(state, hero)
        self.assertNotIn("event:1", packet["available_evidence"])
        review = self.grounded_review(state, hero)
        review["motivation"]["trigger_refs"] = ["event:1"]
        with self.assertRaisesRegex(ctx.ContextError, "accessible prior evidence"):
            self.logical_accept(state, hero, review=review)

    def test_grounded_change_updates_goal_without_leaking_private_reason(self):
        state = self.grounded_fixture("bast")
        candidate = self.logical_candidate(state, [{"kind": "communication", "recipient": "hero", "audience": ["hero", "bast"],
            "content": "Предлагает показать полезную для занятий схему после короткой помощи.", "manner": "По делу", "intensity": "Обычно"}])
        self.logical_accept(state, candidate, next_actor="hero", review=self.grounded_review(state, candidate))
        turn = self.logical_candidate(state, [{"kind": "inner", "motive": "PRIVATE_HERO_REASON: узнать схему для занятий", "emotion": "Интерес"},
            {"kind": "communication", "recipient": "bast", "audience": ["hero", "bast"], "content": "Соглашается на короткую помощь", "manner": "По делу", "intensity": "Обычно"}])
        review = self.grounded_review(state, turn)
        review["motivation"].update(goal_relation="means", next_goal="Помочь, чтобы узнать полезную схему", trigger_refs=["event:1"],
            transition_reason="Получено конкретное предложение, связанное с прежним стремлением учиться.")
        review["motivation"]["decision_basis"][0]["grounds"].append({"ref": "event:1", "quote": "полезную для занятий схему"})
        self.logical_accept(state, turn, next_actor="bast", review=review)
        npc = ctx.build_logical_actor_input(state)
        self.assertNotIn("PRIVATE_HERO_REASON", json.dumps(npc))
        # Verify persisted goal, not an arbitrary reset from entry memory.
        npc_turn = self.logical_candidate(state, [{"kind": "action", "status": "performed", "action": "Кивает", "audience": ["hero", "bast"]}])
        self.logical_accept(state, npc_turn, next_actor="hero", review=self.grounded_review(state, npc_turn))
        self.assertEqual(ctx.build_logical_actor_input(state)["motivation_context"]["current_goal"], "Помочь, чтобы узнать полезную схему")

    def test_motivation_history_and_frame_tampering_invalidates_session(self):
        for key in ("logical_motivation_history", "logical_motivation_frames"):
            state = self.grounded_fixture()
            if key.endswith("history"):
                state[key].append({"actor_id": "hero", "assessment": {"next_goal": "Новая цель"}})
            else:
                state[key]["hero"]["current_goal"] = "Новая цель"
            with self.assertRaisesRegex(ctx.ContextError, "motivation context/history"):
                ctx.build_logical_actor_input(state)

    def test_resolution_schema_does_not_advertise_forbidden_transport_metadata(self):
        state = self.grounded_fixture("lead")
        shape = next(x for x in ctx.build_logical_actor_input(state)["response_schema"]["turn"] if x["kind"] == "resolution")
        self.assertNotIn("permitted_for", shape)

    def test_deleting_grounded_state_fields_cannot_downgrade_to_legacy_acceptance(self):
        for key in ("logical_motivation_frames", "logical_motivation_history", "logical_motivation_history_sha256"):
            state = self.grounded_fixture()
            candidate = self.logical_candidate(state, [{"kind": "inner", "motive": "Продолжить занятия", "emotion": "Спокоен"}])
            review = {"verdict": "continue", "issues": [], "binding": ctx.logical_continuation_binding(state, candidate)}
            del state[key]
            before = json.loads(json.dumps(state))
            with self.assertRaisesRegex(ctx.ContextError, "motivation context/history"):
                ctx.build_logical_actor_input(state)
            with self.assertRaisesRegex(ctx.ContextError, "motivation context/history"):
                self.logical_accept(state, candidate, review=review)
            self.assertEqual(state, before)


if __name__ == "__main__":
    unittest.main()
