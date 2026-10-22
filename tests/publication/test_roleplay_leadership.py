"""Control integrity tests; semantic interest remains a host assessment."""
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

class LeadershipTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixtures.ContextTests(); self.fx.setUp(); self.addCleanup(self.fx.tearDown)
    def publish(self, s, text, next_actor="lead"):
        role=s["actors"][s["current_actor"]]["role"]
        c=self.fx.logical_candidate(s,[{"kind":"action","status":"performed","action":text,"audience":["hero","bast"]}])
        r=({"verdict":"continue","issues":[],"binding":ctx.logical_continuation_binding(s,c)} if role=="leader" else self.fx.grounded_review(s,c))
        ctx.accept_logical_response(s,c,continuation_review=r,next_actor=next_actor)
        return c
    def assess(self, s, phase="opportunity", stimulus="event:1", actions=None, opportunity=None):
        av=ctx._leadership_api().evidence(s)
        return {"phase":phase,"stimulus":[{"ref":stimulus,"quote":av[stimulus]}],
            "interest_basis":[{"ref":"strivings","quote":"Продвинуться в учёбе"}] if phase=="opportunity" else [],
            "options":[{"action":"Уточнить способ","consequence":"Получить сведения ценой времени"},{"action":"Уйти к занятиям","consequence":"Не проверять новую возможность"}] if phase=="opportunity" else [],
            "hero_actions":[{"ref":x,"quote":av[x]} for x in (actions or [])],"causal_link":"Смысловую связь конкретного события и выбора отдельно проверил host.","opportunity_id":opportunity}
    def route(self,s,a,next_actor="hero"):
        return ctx.review_and_route_logical_scene(s,review={"binding":ctx.logical_scene_control_binding(s,assessment=a,next_actor=next_actor),"assessment":a},next_actor=next_actor)
    def test_purpose_is_required_before_first_packet(self):
        s=self.fx.grounded_fixture("lead")
        args=dict(hero_name=s["hero_name"],actors=s["actors"],author_craft=s["author_craft"],actor_guidance=s["logical_actor_guidance"],initial_actor="lead",motivation_frames=s["logical_motivation_frames"])
        for bad in (None,{}, {"functions":["Развитие"]}):
            with self.assertRaisesRegex(ctx.ContextError,"scene_purpose"):ctx.initialize_logical_session(s["bundle"],**args,scene_purpose=bad)
        self.assertIn("scene_purpose",ctx.build_logical_actor_input(s)["scene_task"])
    def test_empty_leader_yield_does_not_create_world_event_or_progress(self):
        s=self.fx.grounded_fixture("lead");c=self.fx.logical_candidate(s,[])
        ctx.accept_logical_response(s,c,continuation_review={"verdict":"continue","issues":[],"binding":ctx.logical_continuation_binding(s,c)},next_actor="hero")
        self.assertEqual(s["transcript"],[]);self.assertEqual(s["logical_scene_history"],[])
    def test_host_route_without_assessment_never_credits_progress(self):
        s=self.fx.grounded_fixture("lead");before=copy.deepcopy(s["transcript"])
        receipt=self.route(s,None)
        self.assertEqual(receipt["world_events_added"],0);self.assertEqual(s["transcript"],before)
        self.assertEqual(s["logical_scene_history"],[])
    def test_npc_event_can_ground_private_opportunity_without_leader_event(self):
        s=self.fx.grounded_fixture("bast");self.publish(s,"NPC показывает доступный герою способ; применимость предстоит проверить.")
        before=copy.deepcopy(s["transcript"]);self.route(s,self.assess(s))
        self.assertEqual(s["transcript"],before);self.assertEqual(s["logical_scene_history"][0]["id"],"scene:1")
        p=ctx.build_logical_actor_input(s)
        self.assertNotIn("scene_task",p);self.assertNotIn("Получить сведения ценой времени",str(p))
    def test_quote_and_option_integrity_is_atomic(self):
        s=self.fx.grounded_fixture("bast");self.publish(s,"Нейтральное событие, не доказательство интереса.")
        for change in ("quote","options","ground"):
            a=self.assess(s)
            if change=="quote":a["stimulus"][0]["quote"]="Не происходило"
            if change=="options":a["options"][1]=a["options"][0]
            if change=="ground":a["interest_basis"][0]["ref"]="npc_private"
            before=copy.deepcopy(s)
            with self.assertRaises(ctx.ContextError):self.route(s,a)
            self.assertEqual(s,before)
    def test_routing_invalidates_old_candidate_and_exact_payload(self):
        s=self.fx.grounded_fixture("lead");c=self.fx.logical_candidate(s,[])
        b=ctx.logical_scene_control_binding(s,assessment=None,next_actor="hero")
        self.route(s,None,"lead")
        with self.assertRaises(ctx.ContextError):ctx.logical_continuation_binding(s,c)
        before=copy.deepcopy(s)
        with self.assertRaisesRegex(ctx.ContextError,"stale"):ctx.review_and_route_logical_scene(s,review={"binding":b,"assessment":None},next_actor="hero")
        self.assertEqual(before,s)
        b=ctx.logical_scene_control_binding(s,assessment=None,next_actor="hero")
        with self.assertRaisesRegex(ctx.ContextError,"stale"):ctx.review_and_route_logical_scene(s,review={"binding":b,"assessment":None},next_actor="bast")
    def test_consequence_needs_specific_opportunity_and_later_hero_action(self):
        s=self.fx.grounded_fixture("bast");self.publish(s,"Показан способ.");self.route(s,self.assess(s),"hero")
        self.publish(s,"Пелун выбирает уйти к занятиям.")
        self.publish(s,"После ухода контакт не продолжился.")
        a=self.assess(s,"consequence","event:3",["event:2"],"scene:1")
        self.route(s,a,None);ctx.finish_live_session(s);self.assertTrue(s["finished"])
    def test_early_consequence_and_recycled_opportunity_are_rejected(self):
        s=self.fx.grounded_fixture("bast");self.publish(s,"Показан способ.")
        with self.assertRaisesRegex(ctx.ContextError,"accepted opportunity"):self.route(s,self.assess(s,"consequence",opportunity="scene:99"))
        self.route(s,self.assess(s),"lead")
        with self.assertRaisesRegex(ctx.ContextError,"recycled"):self.route(s,self.assess(s),"hero")
        with self.assertRaisesRegex(ctx.ContextError,"cannot be empty"):self.route(s,self.assess(s,"consequence",opportunity="scene:1"),None)
    def test_same_consequence_with_fresh_binding_cannot_gain_credit_or_close(self):
        s=self.fx.grounded_fixture("bast");self.publish(s,"Показан способ.");self.route(s,self.assess(s),"hero")
        self.publish(s,"Пелун отказывается и уходит.");self.publish(s,"Контакт не продолжился.")
        a=self.assess(s,"consequence","event:3",["event:2"],"scene:1");self.route(s,a,"lead")
        for next_actor in ("hero",None):
            before=copy.deepcopy(s)
            with self.assertRaisesRegex(ctx.ContextError,"already credited"):self.route(s,a,next_actor)
            self.assertEqual(before,s)
    def credited_with_extra_old_event(self):
        s=self.fx.grounded_fixture("bast");self.publish(s,"Показан способ.");self.route(s,self.assess(s),"hero")
        self.publish(s,"Герой выбрал пробу.","hero");self.publish(s,"Герой выполнил пробу.")
        self.publish(s,"Получен первый результат.");self.publish(s,"Получен второй результат.");self.publish(s,"Ещё старое наблюдение, до зачёта.")
        a=self.assess(s,"consequence","event:4",["event:2","event:3"],"scene:1")
        a["stimulus"].append({"ref":"event:5","quote":ctx._leadership_api().evidence(s)["event:5"]})
        self.route(s,a,"lead")
        return s,a
    def test_subset_superset_and_old_uncited_result_cannot_recredit(self):
        s,a=self.credited_with_extra_old_event()
        for change in ("subset","superset","old_uncited"):
            attempt=copy.deepcopy(a)
            if change=="subset":attempt["hero_actions"]=attempt["hero_actions"][1:];attempt["stimulus"]=attempt["stimulus"][:1]
            if change=="superset":attempt["stimulus"].append({"ref":"event:1","quote":ctx._leadership_api().evidence(s)["event:1"]})
            if change=="old_uncited":attempt["stimulus"].append({"ref":"event:6","quote":ctx._leadership_api().evidence(s)["event:6"]})
            before=copy.deepcopy(s)
            with self.assertRaisesRegex(ctx.ContextError,"new result"):self.route(s,attempt,None)
            self.assertEqual(s,before)
    def test_real_new_result_after_credit_can_advance_same_opportunity(self):
        s,a=self.credited_with_extra_old_event();self.publish(s,"Позднее появилось действительно новое последствие.")
        follow=self.assess(s,"consequence","event:7",["event:3"],"scene:1")
        self.route(s,follow,None);ctx.finish_live_session(s);self.assertTrue(s["finished"])
    def test_no_assessment_or_setup_cannot_close(self):
        s=self.fx.grounded_fixture("lead");self.publish(s,"Видно место для миски.")
        for a in (None,self.assess(s,"setup")):
            before=copy.deepcopy(s)
            with self.assertRaisesRegex(ctx.ContextError,"evidenced consequence"):self.route(s,a,None)
            self.assertEqual(s,before)
    def test_private_npc_inner_is_not_scene_evidence(self):
        s=self.fx.grounded_fixture("bast");c=self.fx.logical_candidate(s,[{"kind":"inner","motive":"NPC_SECRET","emotion":"Спокоен"}])
        ctx.accept_logical_response(s,c,continuation_review=self.fx.grounded_review(s,c),next_actor="lead")
        self.assertEqual(ctx._leadership_api().evidence(s),{})
    def test_leader_sees_updated_goals_and_history_tamper_fails(self):
        s=self.fx.grounded_fixture("hero");h=self.fx.logical_candidate(s,[{"kind":"inner","motive":"Уточнить способ","emotion":"Интерес"}]);r=self.fx.grounded_review(s,h)
        r["motivation"].update(goal_relation="means",next_goal="Уточнить способ для учёбы",transition_reason="Основание в прежнем стремлении",trigger_refs=["ground:entry"])
        ctx.accept_logical_response(s,h,continuation_review=r,next_actor="lead")
        self.assertEqual(ctx.build_logical_actor_input(s)["scene_task"]["character_frames"]["hero"]["current_goal"],"Уточнить способ для учёбы")
        for field in ("logical_scene_history","logical_routing_history"):
            bad=copy.deepcopy(s);del bad[field]
            with self.assertRaises(ctx.ContextError):ctx.build_logical_actor_input(bad)
    def test_hidden_resolution_keeps_private_audience_without_scene_credit(self):
        s=self.fx.grounded_fixture("bast");n=self.fx.logical_candidate(s,[{"kind":"action","status":"attempted","action":"Проверяю дверцу.","target":"дверца","attempt_id":"hidden","audience":["bast"]}])
        ctx.accept_logical_response(s,n,continuation_review=self.fx.grounded_review(s,n),next_actor="lead")
        n=self.fx.logical_candidate(s,[{"kind":"resolution","attempt_id":"hidden","outcome":"blocked","resolution":"Дверца заперта.","audience":["bast"]}])
        ctx.accept_logical_response(s,n,continuation_review={"verdict":"continue","issues":[],"binding":ctx.logical_continuation_binding(s,n)},next_actor="hero")
        self.assertNotIn("Дверца заперта",str(ctx.build_logical_actor_input(s)));self.assertEqual(s["logical_scene_history"],[])
