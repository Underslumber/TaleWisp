import copy
import unittest
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parent))

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = Path(os.environ.get('TALEWISP_TEST_PLUGIN_ROOT', ROOT / 'plugin'))
import test_roleplay_context as fixtures

ctx = fixtures.ctx


class SceneDesignTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixtures.ContextTests(); self.fx.setUp(); self.addCleanup(self.fx.tearDown)
        self.state = self.fx.grounded_fixture("lead"); self.api = ctx._scene_design_api()

    def plan(self):
        s = self.state
        p = self.api.build_input(session_id="design-test", bundle=s["bundle"], actors=s["actors"], frames=s["logical_motivation_frames"],
            purpose=s["bundle"]["logical_scene_purpose"], sources={"source1": "Учёба даётся трудно; герой ищет полезную практику."})
        design = {"purpose": copy.deepcopy(p["context"]["purpose"]), "setup": "В комнате свободно место для миски; дверь открыта.",
            "entries": {k: {"position": "У стола", "activity": "Возвращает миску" if k == "hero" else "Готовит овощи",
                "known_setup": ["Видна миска и открытый проход."]} for k in s["logical_motivation_frames"]},
            "interest_bridge": {"grounds": [{"ref": "source:source1", "quote": "герой ищет полезную практику"},
                {"ref": "actor:hero:strivings", "quote": "Продвинуться в учёбе"}],
                "stimulus": "FUTURE_TRIGGER_PRIVATE: NPC может показать проверяемый приём", "importance": "Связано с поиском практики, не обязанность помогать.",
                "uncertainty": "Полезность для конкретного героя не доказана."},
            "npc_basis": {"goal": "Подготовить овощи", "engagement": "Можно коротко ответить, не бросая работу.", "cost": "Время и границы показа."},
            "choices": [{"action": "Уточнить приём", "cost": "Потратить время", "result": "Проверить возможность"},
                        {"action": "Уйти", "cost": "Не получить сведения", "result": "Продолжить прежние занятия"}],
            "expected_shift": "PRIVATE_INTENDED_SHIFT: возможен первый практический контакт, не дружба.", "additions": ["Комната — пробная постановка."]}
        e = {"packet_binding": copy.deepcopy(p["packet_binding"]), "design": design}
        review = {"binding": self.api.approval_binding(p, e), "verdict": "approve",
            "checks": {k: "Root проверил этот смысловой аспект по конкретному проекту и источникам; это не автоматический художественный PASS." for k in self.api.CHECKS}}
        return p, e, review

    def test_actors_cannot_start_without_design_and_bound_semantic_approval(self):
        with self.assertRaisesRegex(ctx.ContextError, "before approved"):
            ctx.initialize_designed_logical_session(None, hero_name="Беал", author_craft=self.state["author_craft"],
                actor_guidance=self.state["logical_actor_guidance"], initial_actor="hero")
        p, e, r = self.plan(); del r["checks"]["hero_reason"]
        with self.assertRaisesRegex(ValueError, "semantic approval"): self.api.approve(p, e, r)

    def test_design_does_not_change_purpose_or_quote_unsupplied_source(self):
        p, e, r = self.plan()
        for kind in ("purpose", "quote", "goal", "choice"):
            bad = copy.deepcopy(e)
            if kind == "purpose": bad["design"]["purpose"]["why"] = "Другая цель"
            if kind == "quote": bad["design"]["interest_bridge"]["grounds"][0]["quote"] = "Герой обязан согласиться"
            if kind == "goal": bad["design"]["entries"]["hero"]["goal"] = "Обязательно помочь"
            if kind == "choice": bad["design"]["choices"][1] = bad["design"]["choices"][0]
            with self.assertRaises(ValueError): self.api.validate_response(p, bad)

    def test_input_response_or_review_tampering_is_rejected(self):
        p, e, r = self.plan(); approved = self.api.approve(p, e, r)
        for kind in ("input", "design", "review"):
            bad = copy.deepcopy(approved)
            if kind == "input": bad["input"]["context"]["grounds"]["source:source1"] = "Изменённый источник"
            if kind == "design": bad["response"]["design"]["setup"] = "Новая постановка"
            if kind == "review": bad["review"]["binding"]["design_sha256"] = "0" * 64
            with self.assertRaises(ValueError): self.api.materialize(bad)

    def test_only_own_entry_facts_reach_characters_and_goals_survive(self):
        p, e, r = self.plan(); before = copy.deepcopy(p)
        approved = self.api.approve(p, e, r)
        for actor in ("hero", "bast"):
            s = ctx.initialize_designed_logical_session(approved, hero_name="Беал", author_craft=self.state["author_craft"],
                actor_guidance=self.state["logical_actor_guidance"], initial_actor=actor)
            packet = ctx.build_logical_actor_input(s)
            self.assertNotIn("FUTURE_TRIGGER_PRIVATE", str(packet)); self.assertNotIn("PRIVATE_INTENDED_SHIFT", str(packet))
            self.assertNotIn("scene_task", packet); self.assertEqual(s["transcript"], [])
            self.assertEqual(s["logical_motivation_frames"][actor]["current_goal"], p["context"]["frames"][actor]["current_goal"])
            self.assertEqual(packet["memory"]["own_memory"]["observations"], e["design"]["entries"][actor]["known_setup"])
        self.assertEqual(p, before)

    def test_leader_receives_private_design_without_played_future_events(self):
        p, e, r = self.plan(); approved = self.api.approve(p, e, r)
        s = ctx.initialize_designed_logical_session(approved, hero_name="Беал", author_craft=self.state["author_craft"],
            actor_guidance=self.state["logical_actor_guidance"], initial_actor="lead")
        self.assertIn("FUTURE_TRIGGER_PRIVATE", str(ctx.build_logical_actor_input(s)["author_scene_context"]))
        self.assertEqual(s["transcript"], [])

    def test_global_setup_and_other_character_entry_do_not_bypass_projection(self):
        p, e, r = self.plan()
        e["design"]["setup"] += " PRIVATE_GLOBAL_CORNER: событие за закрытой перегородкой."
        e["design"]["entries"]["hero"]["known_setup"].append("HERO_ENTRY_ONLY")
        e["design"]["entries"]["bast"]["known_setup"].append("BAST_ENTRY_ONLY")
        r["binding"] = self.api.approval_binding(p, e)
        approved = self.api.approve(p, e, r)
        for actor, own, other in (("hero", "HERO_ENTRY_ONLY", "BAST_ENTRY_ONLY"), ("bast", "BAST_ENTRY_ONLY", "HERO_ENTRY_ONLY")):
            s = ctx.initialize_designed_logical_session(approved, hero_name="Беал", author_craft=self.state["author_craft"],
                actor_guidance=self.state["logical_actor_guidance"], initial_actor=actor)
            packet = str(ctx.build_logical_actor_input(s))
            self.assertIn(own, packet); self.assertNotIn(other, packet); self.assertNotIn("PRIVATE_GLOBAL_CORNER", packet)
        s = ctx.initialize_designed_logical_session(approved, hero_name="Беал", author_craft=self.state["author_craft"],
            actor_guidance=self.state["logical_actor_guidance"], initial_actor="lead")
        self.assertIn("PRIVATE_GLOBAL_CORNER", str(ctx.build_logical_actor_input(s)))
