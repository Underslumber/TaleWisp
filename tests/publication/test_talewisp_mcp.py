import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[2]
PLUGIN = Path(os.environ.get('TALEWISP_TEST_PLUGIN_ROOT', ROOT / 'plugin'))


SERVER = PLUGIN / "scripts" / "talewisp_mcp.py"
SPEC = importlib.util.spec_from_file_location("talewisp_mcp", SERVER)
tw = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = tw
SPEC.loader.exec_module(tw)


class TaleWispMcpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "Персонажи").mkdir()
        (self.root / "Сцены").mkdir()
        (self.root / "Персонажи" / "Алиса.md").write_text(
            "---\ntype: character\ntitle: Алиса\ncanon_status: confirmed\n---\n\nАлиса носит синий плащ.\n",
            encoding="utf-8",
        )
        (self.root / "Сцены" / "Сцена 1.md").write_text(
            "---\ntype: scene\ntitle: Сцена 1\ncharacters: [\"[[Алиса]]\"]\n---\n\nАлиса вошла в дом. [[Алиса]]\n",
            encoding="utf-8",
        )
        tw.STATE.root = self.root
        self.project_patch = patch.object(tw, "PROJECT_ROOT", self.root)
        self.project_patch.start()

    def tearDown(self):
        self.project_patch.stop()
        self.temp.cleanup()

    def test_model_selection_tool_and_vault_scope(self):
        self.assertIn("talewisp_model_selection", {item["name"] for item in tw.TOOLS})
        args = {"model": "custom", "effort": "low", "choice": "project"}
        response = tw.handle({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                              "params": {"name": "talewisp_model_selection", "arguments": args}})
        self.assertFalse(response["result"]["isError"])
        saved = response["result"]["structuredContent"]["selection"]
        other_vault = self.root / "separate-vault"
        other_vault.mkdir()
        status = tw.select_vault({"path": str(other_vault)})
        self.assertEqual(status["model_selection"]["project_default"], saved)
        self.assertEqual(tw.onboarding_status({})["model_selection"]["project_default"], saved)
        self.assertEqual(tw.model_selection({})["selection"], saved)
        self.assertFalse((other_vault / ".talewisp/model-selection.json").exists())

    def test_model_selection_rejects_outside_anchor_and_accepts_descendant(self):
        with self.assertRaises(tw.TaleWispError):
            tw.model_selection({"project_root": str(self.root.parent)})
        descendant = self.root / "child"
        descendant.mkdir()
        result = tw.model_selection({"project_root": "child", "model": "custom", "effort": "high", "choice": "project"})
        self.assertTrue(result["ready"])
        self.assertEqual(tw.model_selection({})["selection"]["model"], "gpt-6.1-sol")

    def test_model_selection_errors_are_visible_mcp_errors(self):
        response = tw.handle({"jsonrpc": "2.0", "id": 8, "method": "tools/call",
                              "params": {"name": "talewisp_model_selection", "arguments": {"effort": "low", "available_models": {"gpt-6.1-sol": ["medium"]}}}})
        self.assertTrue(response["result"]["isError"])
        self.assertIn("Unavailable", response["result"]["structuredContent"]["error"])

    def test_status_search_and_context(self):
        status = tw.project_status({})
        self.assertEqual(status["files"], 2)
        self.assertEqual(status["types"]["scene"], 1)
        search = tw.search_story({"query": "синий плащ"})
        self.assertEqual(search["returned"], 1)
        context = tw.scene_context({"path": "Сцены/Сцена 1.md"})
        self.assertEqual(context["linked_context"][0]["path"], "Персонажи/Алиса.md")

    def test_scene_context_respects_budget_and_reports_omissions(self):
        (self.root / "Сцены" / "Сцена 1.md").write_text(
            "А" * 5000 + " [[Алиса]]",
            encoding="utf-8",
        )
        context = tw.scene_context({"path": "Сцены/Сцена 1.md", "max_chars": 4000})
        self.assertEqual(context["characters_used"], 4000)
        self.assertLessEqual(context["characters_used"], 4000)
        self.assertTrue(context["scene"]["truncated"])
        self.assertEqual(context["scene"]["omitted_characters"], 1010)
        self.assertTrue(context["truncated_by_budget"])
        self.assertEqual(context["omitted_context"][0]["path"], "Персонажи/Алиса.md")

    def test_scene_context_follows_only_linked_style_index_children(self):
        profiles = self.root / "Профили"
        profiles.mkdir()
        (self.root / "Сцены" / "Сцена 1.md").write_text(
            "---\ntype: scene\n---\n\n[[Профили/Профиль стиля]]\n",
            encoding="utf-8",
        )
        (profiles / "Профиль стиля.md").write_text(
            "---\ntype: style-index\n---\n\n[[Голос]] [[Жанр]] [[Режим]]\n",
            encoding="utf-8",
        )
        for name in ("Голос", "Жанр", "Режим"):
            (profiles / f"{name}.md").write_text(
                "---\ntype: style-profile\n---\n\n[[Профиль стиля]]\n",
                encoding="utf-8",
            )
        (profiles / "Нерелевантный.md").write_text(
            "---\ntype: style-profile\n---\n\nНе связан ссылкой.\n",
            encoding="utf-8",
        )
        context = tw.scene_context({"path": "Сцены/Сцена 1.md", "max_link_depth": 2})
        paths = [entry["path"] for entry in context["linked_context"]]
        self.assertEqual(paths, [
            "Профили/Профиль стиля.md",
            "Профили/Голос.md",
            "Профили/Жанр.md",
            "Профили/Режим.md",
        ])
        self.assertEqual(len(paths), len(set(paths)))
        self.assertNotIn("Профили/Нерелевантный.md", paths)

    def test_scene_context_does_not_expand_an_ordinary_style_profile(self):
        profiles = self.root / "Профили"
        profiles.mkdir()
        (self.root / "Сцены" / "Сцена 1.md").write_text(
            "[[Профили/Голос]]\n",
            encoding="utf-8",
        )
        (profiles / "Голос.md").write_text(
            "---\ntype: style-profile\nprofile_kind: author-voice\n---\n\n[[Дочерний профиль]]\n",
            encoding="utf-8",
        )
        (profiles / "Дочерний профиль.md").write_text(
            "---\ntype: style-profile\nprofile_kind: genre-contract\n---\n",
            encoding="utf-8",
        )
        context = tw.scene_context({"path": "Сцены/Сцена 1.md", "max_link_depth": 2})
        self.assertEqual([entry["path"] for entry in context["linked_context"]], ["Профили/Голос.md"])

    def test_scene_context_reports_missing_and_ambiguous_links(self):
        (self.root / "Книги").mkdir()
        (self.root / "Архив").mkdir()
        (self.root / "Книги" / "Замысел книги.md").write_text("Первый\n", encoding="utf-8")
        (self.root / "Архив" / "Замысел книги.md").write_text("Второй\n", encoding="utf-8")
        (self.root / "Сцены" / "Сцена 1.md").write_text(
            "[[Замысел книги]] [[Неизвестный файл]]\n",
            encoding="utf-8",
        )
        context = tw.scene_context({"path": "Сцены/Сцена 1.md"})
        details = {item["target"]: item for item in context["unresolved_link_details"]}
        self.assertEqual(details["Замысел книги"]["status"], "ambiguous")
        self.assertEqual(details["Замысел книги"]["candidates"], [
            "Архив/Замысел книги.md", "Книги/Замысел книги.md",
        ])
        self.assertEqual(details["Неизвестный файл"]["status"], "missing")
        self.assertEqual(details["Неизвестный файл"]["candidates"], [])
        self.assertIsNone(tw.resolve_wikilink("Замысел книги", self.root / "Сцены" / "Сцена 1.md"))

    def test_scene_context_distinguishes_link_limit_from_budget_truncation(self):
        (self.root / "Персонажи" / "Боб.md").write_text("Боб\n", encoding="utf-8")
        (self.root / "Сцены" / "Сцена 1.md").write_text(
            "[[Алиса]] [[Боб]]\n",
            encoding="utf-8",
        )
        with patch.object(tw, "MAX_SCENE_CONTEXT_LINKS", 1):
            context = tw.scene_context({"path": "Сцены/Сцена 1.md"})
        self.assertTrue(context["traversal_limited"])
        self.assertFalse(context["truncated_by_budget"])
        self.assertIn({"reason": "link_limit", "limit": 1}, context["omitted_context"])

    def test_proposal_requires_confirmation_and_backs_up(self):
        source = "Сцены/Сцена 1.md"
        replacement = "---\ntype: scene\n---\n\nНовая версия.\n"
        saved = tw.save_proposal({
            "proposal_type": "revision",
            "title": "Новая версия сцены",
            "source_path": source,
            "replacement_text": replacement,
        })
        with self.assertRaises(tw.TaleWispError):
            tw.apply_proposal({"proposal_path": saved["proposal"], "confirmed": False})
        applied = tw.apply_proposal({"proposal_path": saved["proposal"], "confirmed": True})
        self.assertEqual((self.root / source).read_text(encoding="utf-8"), replacement)
        self.assertTrue((self.root / applied["backup"]).is_file())

    def test_apply_proposal_uses_unique_backup_for_a_reused_timestamp(self):
        source = "Сцены/Сцена 1.md"
        with patch.object(tw, "utc_stamp", return_value="20260908T010203Z"):
            first = tw.save_proposal({
                "proposal_type": "revision",
                "title": "Первая версия",
                "source_path": source,
                "replacement_text": "Первая замена.\n",
            })
            first_applied = tw.apply_proposal({"proposal_path": first["proposal"], "confirmed": True})
            second = tw.save_proposal({
                "proposal_type": "revision",
                "title": "Вторая версия",
                "source_path": source,
                "replacement_text": "Вторая замена.\n",
            })
            second_applied = tw.apply_proposal({"proposal_path": second["proposal"], "confirmed": True})
        self.assertNotEqual(first_applied["backup"], second_applied["backup"])
        self.assertEqual((self.root / first_applied["backup"]).read_text(encoding="utf-8"),
                         "---\ntype: scene\ntitle: Сцена 1\ncharacters: [\"[[Алиса]]\"]\n---\n\nАлиса вошла в дом. [[Алиса]]\n")
        self.assertEqual((self.root / second_applied["backup"]).read_text(encoding="utf-8"), "Первая замена.\n")

    def test_standalone_proposal_creates_new_target(self):
        replacement = "---\ntype: style-profile\n---\n\nАвторский почерк.\n"
        saved = tw.save_proposal({
            "proposal_type": "canon",
            "title": "Авторский почерк",
            "replacement_text": replacement,
        })
        target = "00_Автор/Авторский почерк.md"
        applied = tw.apply_proposal({
            "proposal_path": saved["proposal"],
            "target_path": target,
            "confirmed": True,
        })
        self.assertEqual((self.root / target).read_text(encoding="utf-8"), replacement)
        self.assertIsNone(applied["backup"])

    def test_standalone_proposal_does_not_overwrite_existing_target(self):
        target = "Персонажи/Алиса.md"
        saved = tw.save_proposal({
            "proposal_type": "canon",
            "title": "Не перезаписывать",
            "replacement_text": "Новый текст.\n",
        })
        with self.assertRaises(tw.TaleWispError):
            tw.apply_proposal({
                "proposal_path": saved["proposal"],
                "target_path": target,
                "confirmed": True,
            })

    def test_path_cannot_escape_vault(self):
        with self.assertRaises(tw.TaleWispError):
            tw.read_file({"path": "../outside.md"})

    def test_mcp_initialize_and_tool_list(self):
        response = tw.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}})
        self.assertEqual(response["result"]["serverInfo"]["name"], "talewisp")
        response = tw.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        names = {item["name"] for item in response["result"]["tools"]}
        self.assertIn("talewisp_scene_context", names)
        self.assertIn("talewisp_onboarding_status", names)
        self.assertIn("talewisp_compare_style_edit", names)
        self.assertIn("talewisp_apply_proposal", names)

    def test_compare_style_edit_reports_minimal_and_substantial_changes(self):
        minimal = tw.compare_style_edit({
            "ai_text": "Он вошёл в комнату, остановился у окна и тихо закрыл за собой тяжёлую дверь.",
            "author_text": "Он вошёл в комнату, остановился у окна и тихо прикрыл за собой тяжёлую дверь.",
        })
        self.assertEqual(minimal["change_band"], "minimal")
        self.assertGreater(minimal["change_percent"], 0)
        self.assertTrue(minimal["diff_segments"])

        substantial = tw.compare_style_edit({
            "ai_text": "Он вошёл в комнату.",
            "author_text": "Дверь вздрогнула. Из темноты пахнуло железом, и герой остановился на пороге.",
        })
        self.assertEqual(substantial["change_band"], "substantial")

    def test_onboarding_status_recommends_author_and_style_routes(self):
        (self.root / "Профиль автора.md").write_text(
            "---\ntype: author-profile\nsetup_status: empty\ncanon_status: draft\n---\n",
            encoding="utf-8",
        )
        status = tw.onboarding_status({})
        self.assertTrue(status["first_run"])
        codes = {item["code"] for item in status["recommended_routes"]}
        self.assertIn("author_introduction", codes)
        self.assertIn("request_style_sample", codes)

        (self.root / "Профиль автора.md").write_text(
            "---\ntype: author-profile\nsetup_status: confirmed\ncanon_status: confirmed\n---\n",
            encoding="utf-8",
        )
        (self.root / "Сцены" / "Сцена 1.md").write_text(
            "---\ntype: scene\ntitle: Сцена 1\n---\n\n" + ("Художественный текст. " * 40),
            encoding="utf-8",
        )
        status = tw.onboarding_status({})
        self.assertFalse(status["first_run"])
        codes = {item["code"] for item in status["recommended_routes"]}
        self.assertIn("style_analysis", codes)

    def test_onboarding_status_keeps_multiple_profiles_ambiguous(self):
        profiles = self.root / "Профили"
        profiles.mkdir()
        (profiles / "Голос автора.md").write_text(
            "---\ntype: style-profile\nprofile_kind: author-voice\nscope: series-a\nsetup_status: confirmed\n---\n",
            encoding="utf-8",
        )
        (profiles / "Голос книги.md").write_text(
            "---\ntype: style-profile\nprofile_kind: author-voice\nscope: book-b\nsetup_status: draft\n---\n",
            encoding="utf-8",
        )
        (profiles / "Замысел A.md").write_text(
            "---\ntype: book-brief\nbook: A\nsetup_status: confirmed\n---\n",
            encoding="utf-8",
        )
        (profiles / "Замысел B.md").write_text(
            "---\ntype: book-brief\nbook: B\nsetup_status: draft\n---\n",
            encoding="utf-8",
        )
        status = tw.onboarding_status({})
        voice = status["style_profiles"]["author_voice"]
        self.assertEqual(voice["state"], "ambiguous")
        self.assertTrue(voice["ambiguous"])
        self.assertEqual([(item["path"], item["scope"]) for item in voice["profiles"]], [
            ("Профили/Голос автора.md", {"scope": "series-a"}),
            ("Профили/Голос книги.md", {"scope": "book-b"}),
        ])
        self.assertEqual(status["book_brief"]["state"], "ambiguous")
        self.assertIsNone(status["active_book"])

    def test_stdio_protocol_uses_utf8_when_pythonioencoding_is_cp1251(self):
        (self.root / "Профиль автора.md").write_text(
            "---\ntype: author-profile\n---\n\nКириллица → 😀\n",
            encoding="utf-8",
        )
        environment = dict(os.environ)
        environment["TALEWISP_VAULT"] = str(self.root)
        environment["PYTHONIOENCODING"] = "cp1251"
        request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "talewisp_read_file",
                "arguments": {"path": "Профиль автора.md"},
            },
        }
        completed = subprocess.run(
            [sys.executable, str(SERVER)],
            input=(json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            check=False,
            timeout=10,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", errors="replace"))
        response = json.loads(completed.stdout.decode("utf-8"))
        content = response["result"]["structuredContent"]["content"]
        self.assertIn("Кириллица → 😀", content)


if __name__ == "__main__":
    unittest.main()
