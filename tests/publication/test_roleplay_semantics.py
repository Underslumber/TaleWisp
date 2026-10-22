import importlib.util
import copy
from pathlib import Path
import unittest
import os

import sys
sys.path.insert(0, str(Path(__file__).parent))
ROOT = Path(__file__).resolve().parents[2]
PLUGIN = Path(os.environ.get('TALEWISP_TEST_PLUGIN_ROOT', ROOT / 'plugin'))

PATH=PLUGIN / "scripts/roleplay_semantics.py"
SPEC=importlib.util.spec_from_file_location("roleplay_semantics_test",PATH)
sem=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(sem)

class RoleplaySemanticsTests(unittest.TestCase):
    def setUp(self):
        self.inventory={"facts":[{"id":"goal","claim":"Find the medicine.","status":"active","target":"hero.goals","known_to":["hero"],"required_roles":["hero","leader"]},{"id":"secret","claim":"Private route.","status":"active","target":"world.rules","known_to":["leader"],"required_roles":["leader"]}],"unknowns":[{"id":"weather","gap":"Weather is not established.","blocks_when":"A weather-dependent action is considered."}]}
        self.context={"hero_activity":{"value":"Examines the mark."},"leader_only_context":[{"value":"Private route."}]}
        self.kernel=[{"id":"goal_node","layer":"hero","slot":"goal","ref":{"fact_id":"goal"},"holder":["hero","leader"]},
                     {"id":"tension_node","layer":"scene","slot":"tension","ref":{"scene_context":{"field":"hero_activity"}},"holder":["hero","leader"],"links":[{"rel":"informs","to":"goal_node"}]},
                     {"id":"private","layer":"scene","slot":"affordance","ref":{"scene_context":{"field":"leader_only_context"}},"holder":["leader"],"background":True}]

    def test_role_projection_filters_private_targets_and_links(self):
        checked=sem.validate_kernel(self.kernel,self.inventory,self.context)
        hero=sem.project_kernel(checked,"hero",inventory=self.inventory,scene_context=self.context)
        self.assertEqual({x["id"] for x in hero},{"goal_node","tension_node"})
        self.assertNotIn("private",str(hero)); self.assertEqual(hero[0]["text"],"Find the medicine.")
        self.assertEqual(sem.project_kernel(checked,"formatter"),[])

    def test_forbidden_slots_and_unprojected_or_unknown_hero_refs_fail(self):
        bad=[dict(self.kernel[0],slot="required_reaction")]
        with self.assertRaises(sem.SemanticsError): sem.validate_kernel(bad,self.inventory,self.context)
        bad=[{"id":"wrong","layer":"hero","slot":"goal","ref":{"scene_context":{"field":"leader_only_context"}}}]
        with self.assertRaises(sem.SemanticsError): sem.validate_kernel(bad,self.inventory,self.context)
        bad=[{"id":"weather","layer":"hero","slot":"knowledge","ref":{"fact_id":"weather"}}]
        with self.assertRaises(sem.SemanticsError): sem.validate_kernel(bad,self.inventory,self.context)

    def test_tension_needs_hero_stake_and_condition_needs_perceiver_class(self):
        bad=[{"id":"t","layer":"scene","slot":"tension","ref":{"scene_context":{"field":"hero_activity"}},"links":[]}]
        with self.assertRaises(sem.SemanticsError): sem.validate_kernel(bad,self.inventory,self.context)
        bad=[{"id":"c","layer":"scene","slot":"condition","ref":{"scene_context":{"field":"hero_activity"}}}]
        with self.assertRaises(sem.SemanticsError): sem.validate_kernel(bad,self.inventory,self.context)

    def test_event_requires_hero_observation_and_stimulus_perception(self):
        event={"id":"e1","origin":"environment","cause":{"kind":"kernel","ref":"goal_node"},"access":{"channel":"sound","via":"goal_node","detail":"A knock reaches the room."},"perceivers":["hero"],"relevance":["goal_node"],"observations":["Footsteps sound."],"revealed_to_hero":["Footsteps sound."]}
        checked=sem.validate_kernel(self.kernel,self.inventory,self.context)
        sem.validate_event(event,[],checked)
        self.assertEqual(sem.validate_stimulus("e1",[],event),"e1")
        event["revealed_to_hero"]=[]
        with self.assertRaises(sem.SemanticsError): sem.validate_event(event,[],checked)
        with self.assertRaises(sem.SemanticsError): sem.validate_stimulus("e1",[],{**event,"perceivers":[]})

    def test_npc_memory_requires_local_perceived_basis(self):
        turns=[{"event":{"id":"e1","perceivers":["npc:guard"]}}]
        sem.validate_npc_memory({"holder":"npc:guard","basis_event":"e1"},turns,None)
        with self.assertRaises(sem.SemanticsError): sem.validate_npc_memory({"holder":"npc:guard","basis_event":"e1"},[],None)

    def test_scene_layer_hero_holder_cannot_point_to_leader_secret_and_projection_filters_old_nodes(self):
        secret={"id":"leak","layer":"scene","slot":"affordance","ref":{"fact_id":"secret"},"holder":["hero"],"background":True}
        with self.assertRaises(sem.SemanticsError): sem.validate_kernel(self.kernel+[secret],self.inventory,self.context)
        checked=sem.validate_kernel(self.kernel,self.inventory,self.context)
        self.assertNotIn("leak",str(sem.project_kernel(checked+[secret],"hero",inventory=self.inventory,scene_context=self.context)))

    def test_typed_unknown_projects_only_as_leader_gap(self):
        unknown={"id":"weather_gap","layer":"scene","slot":"not_established","ref":{"unknown_id":"weather"},"holder":["leader"],"background":True}
        checked=sem.validate_kernel(self.kernel+[unknown],self.inventory,self.context)
        leader=sem.project_kernel(checked,"leader",inventory=self.inventory,scene_context=self.context)
        item=next(x for x in leader if x["id"]=="weather_gap")
        self.assertEqual(item["not_established"],{"gap":"Weather is not established.","blocks_when":"A weather-dependent action is considered."})
        self.assertNotIn("weather_gap",str(sem.project_kernel(checked,"hero",inventory=self.inventory,scene_context=self.context)))
        bad={**unknown,"ref":{"fact_id":"weather"}}
        with self.assertRaises(sem.SemanticsError): sem.validate_kernel(self.kernel+[bad],self.inventory,self.context)

    def test_cause_and_access_require_typed_local_basis_and_detail(self):
        kernel=sem.validate_kernel(self.kernel,self.inventory,self.context)
        base={"id":"e2","origin":"environment","cause":{"kind":"hidden","basis":{"kind":"kernel","ref":"goal_node"},"detail":"The cause remains private."},"access":{"channel":"sound","via":"goal_node","detail":"A sharp knock reaches the room."},"perceivers":[],"relevance":"ambient","observations":[]}
        sem.validate_event(base,[],kernel)
        for cause,access in [
            ({"kind":"hidden","basis":{"kind":"kernel","ref":"goal_node"}},base["access"]),
            ({"kind":"hidden","basis":{"kind":"prior_event","ref":"future"},"detail":"private"},base["access"]),
            ({"kind":"hero_action","ref":"turn:1"},base["access"]),
            (base["cause"],{"channel":"sound","via":"goal_node","detail":"  "}),
            (["malformed"],base["access"]),
        ]:
            with self.assertRaises(sem.SemanticsError): sem.validate_event({**base,"cause":cause,"access":access},[],kernel)

    def test_event_relevance_must_be_ambient_or_nonempty_existing_ids(self):
        kernel=sem.validate_kernel(self.kernel,self.inventory,self.context)
        base={"id":"relevance_evt","origin":"environment","cause":{"kind":"kernel","ref":"goal_node"},
              "access":{"channel":"sight","via":"goal_node","detail":"The mark is visible."},
              "perceivers":[],"observations":[]}
        for relevance in (None, [], ["missing"], ["goal_node", 3]):
            with self.subTest(relevance=relevance), self.assertRaises(sem.SemanticsError):
                sem.validate_event({**base,"relevance":relevance},[],kernel)
        self.assertEqual(sem.validate_event({**base,"relevance":"ambient"},[],kernel)["relevance"],"ambient")
        self.assertEqual(sem.validate_event({**base,"relevance":["goal_node"]},[],kernel)["relevance"],["goal_node"])

    def test_kernel_refs_reject_non_declaration_scene_values(self):
        for value in (None, "unstructured text", {"value":"  "}):
            with self.subTest(value=value), self.assertRaises(sem.SemanticsError):
                sem.validate_kernel(self.kernel,self.inventory,{**self.context,"hero_activity":value})

    def test_leader_projection_keeps_each_npc_motive_and_access_binding_private(self):
        context=copy.deepcopy(self.context)
        context["leader_only_context"]=[
            {"value":"NPC identity: Sera."},{"value":"NPC identity: Dain."},
            {"value":"Motive: protect her sister."},{"value":"Access: holds the courtyard key."},
            {"value":"Motive: sell a route to a rival."},{"value":"Access: enters through the drainage passage."},
        ]
        npc_nodes=[
            {"id":"sera","layer":"leader","slot":"npc","ref":{"scene_context":{"field":"leader_only_context","index":0}},
             "motive_ref":{"scene_context":{"field":"leader_only_context","index":2}},
             "access_ref":{"scene_context":{"field":"leader_only_context","index":3}},"background":True},
            {"id":"dain","layer":"leader","slot":"npc","ref":{"scene_context":{"field":"leader_only_context","index":1}},
             "motive_ref":{"scene_context":{"field":"leader_only_context","index":4}},
             "access_ref":{"scene_context":{"field":"leader_only_context","index":5}},"background":True},
        ]
        kernel=sem.validate_kernel(self.kernel+npc_nodes,self.inventory,context)
        leader=sem.project_kernel(kernel,"leader",inventory=self.inventory,scene_context=context)
        by_id={item["id"]:item for item in leader}
        self.assertEqual((by_id["sera"]["text"],by_id["sera"]["motive"],by_id["sera"]["access"]),
                         ("NPC identity: Sera.","Motive: protect her sister.","Access: holds the courtyard key."))
        self.assertEqual((by_id["dain"]["text"],by_id["dain"]["motive"],by_id["dain"]["access"]),
                         ("NPC identity: Dain.","Motive: sell a route to a rival.","Access: enters through the drainage passage."))
        swapped=copy.deepcopy(npc_nodes)
        swapped[0]["motive_ref"],swapped[1]["motive_ref"]=swapped[1]["motive_ref"],swapped[0]["motive_ref"]
        swapped[0]["access_ref"],swapped[1]["access_ref"]=swapped[1]["access_ref"],swapped[0]["access_ref"]
        swapped_kernel=sem.validate_kernel(self.kernel+swapped,self.inventory,context)
        swapped_by_id={item["id"]:item for item in sem.project_kernel(swapped_kernel,"leader",inventory=self.inventory,scene_context=context)}
        self.assertEqual(swapped_by_id["sera"]["motive"],"Motive: sell a route to a rival.")
        self.assertEqual(swapped_by_id["sera"]["access"],"Access: enters through the drainage passage.")
        self.assertEqual(swapped_by_id["dain"]["motive"],"Motive: protect her sister.")
        self.assertEqual(swapped_by_id["dain"]["access"],"Access: holds the courtyard key.")
        for role in ("hero","formatter"):
            projection=sem.project_kernel(kernel,role,inventory=self.inventory,scene_context=context)
            self.assertNotIn("motive",str(projection))
            self.assertNotIn("access",str(projection))
            self.assertNotIn("sister",str(projection))
            self.assertNotIn("drainage",str(projection))

    def test_npc_only_event_observations_never_enter_hero_projection(self):
        event={"id":"npc_evt","perceivers":["npc:guard"],"observations":["npc-only-canary"],"revealed_to_hero":[]}
        self.assertIsNone(sem.project_event_for_hero(event))
        event["observations"]=[]
        self.assertIsNone(sem.project_event_for_hero(event))

    def test_historical_npc_memory_does_not_become_current_branch_knowledge(self):
        from test_roleplay import rp
        carried=rp._historicalize_npc_memory([{"kind":"fact","text":"Saw the hidden route.","holder":"npc:guard","basis_event":"e1"}],
            {"session_id":"old-session","branch_id":"old-branch","story_time":{"id":"old-time","ordinal":1}})
        self.assertEqual(carried[0]["holder"],"historical:npc:guard")
        self.assertEqual(carried[0]["historical_origin"],{"session_id":"old-session","branch_id":"old-branch","story_time":{"id":"old-time","ordinal":1},"holder":"npc:guard","basis_event":"e1"})
        with self.assertRaises(sem.SemanticsError): sem.validate_npc_memory({"holder":"npc:guard","basis_event":"e1"},[],None)

    def test_hero_projection_uses_safe_hero_inventory_and_suppresses_accepted_delta(self):
        from test_roleplay import rp
        state={"role_context_packets":{"hero":[],"leader":[{"fact_id":"secret","claim":"Private route.","status":"active","known_to":["hero"]}]},
               "hero_kernel_fact_ids":["goal"],"kernel":[{"id":"g","layer":"hero","slot":"goal","ref":{"fact_id":"goal"},"holder":["hero"]}],
               "accepted_character_deltas":{},"fact_target_index":{}}
        state["role_context_packets"]["hero"]=[{"fact_id":"goal","claim":"Find the medicine.","status":"active","known_to":["hero"]}]
        self.assertEqual(rp._project_branch_kernel(state,"hero")[0]["text"],"Find the medicine.")
        state["accepted_character_deltas"]={"goals":["Find another goal."]}
        state["fact_target_index"]={"goal":"hero.goals"}
        self.assertEqual(rp._project_branch_kernel(state,"hero"),[])

    def test_kernel_rejects_decoration_without_live_scene_bridge(self):
        disconnected=[self.kernel[0],{"id":"affordance","layer":"scene","slot":"affordance","ref":{"scene_context":{"field":"hero_activity"}},"holder":["leader"]}]
        with self.assertRaises(sem.SemanticsError): sem.validate_kernel(disconnected,self.inventory,self.context)
        decorative=[{**item,"background":True} for item in self.kernel]
        with self.assertRaises(sem.SemanticsError): sem.validate_kernel(decorative,self.inventory,self.context)

    def test_boolean_indices_and_malformed_validation_inputs_fail_as_semantic_errors(self):
        bad=[{"id":"goal_node","layer":"hero","slot":"goal","ref":{"fact_id":"goal"},"holder":["hero"]},
             {"id":"npc_guard","layer":"leader","slot":"npc","ref":{"scene_context":{"field":"leader_only_context"}},
              "motive_ref":{"scene_context":{"field":"leader_only_context","index":True}},
              "access_ref":{"scene_context":{"field":"leader_only_context","index":0}},"holder":["leader"]},
             {"id":"scene","layer":"scene","slot":"affordance","ref":{"scene_context":{"field":"hero_activity"}},"holder":["leader"],"links":[{"rel":"informs","to":"goal_node"}]}]
        with self.assertRaises(sem.SemanticsError): sem.validate_kernel(bad,self.inventory,self.context)
        with self.assertRaises(sem.SemanticsError): sem.validate_kernel(self.kernel,[],self.context)
        with self.assertRaises(sem.SemanticsError): sem.validate_event({"id":"bad"},[None],[])

if __name__=="__main__": unittest.main()
