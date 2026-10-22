import importlib.util
import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("graphify_code", ROOT / "scripts/graphify_code.py")
graphify_code = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(graphify_code)
BENCH_SPEC = importlib.util.spec_from_file_location("graphify_benchmark", ROOT / "scripts/graphify_benchmark.py")
graphify_benchmark = importlib.util.module_from_spec(BENCH_SPEC)
BENCH_SPEC.loader.exec_module(graphify_benchmark)


class GraphifyCodeTests(unittest.TestCase):
    def _junction(self, path, target):
        if os.name != "nt":
            self.skipTest("Windows junction test")
        quoted_path = str(path).replace("'", "''")
        quoted_target = str(target).replace("'", "''")
        script = f"New-Item -ItemType Junction -Path '{quoted_path}' -Target '{quoted_target}' | Out-Null"
        result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", script], capture_output=True, text=True)
        if result.returncode:
            self.skipTest(f"Junction creation unavailable: {result.stderr.strip()}")

    def test_allowlist_excludes_private_vault_and_local_plugin_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for rel in (
                "plugin/scripts/source.py",
                "tests/publication/test_public.py",
                "scripts/build_release.py",
                "scripts/graphify_code.py",
                "scripts/graphify_benchmark.py",
                "scripts/export_public.py",
                "plugins/talewisp/scripts/local.py",
                "vault/secret.py",
            ):
                path = root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("pass\n", encoding="utf-8")

            paths = {path.relative_to(root).as_posix() for path in graphify_code._corpus(root)}

        self.assertEqual(paths, {"plugin/scripts/source.py", "tests/publication/test_public.py", "scripts/build_release.py"})

    def test_benchmark_resolves_rtk_from_user_local_bin(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            exe = home / ".local/bin/rtk.exe"
            exe.parent.mkdir(parents=True)
            exe.write_text("stub", encoding="utf-8")
            with patch.object(graphify_benchmark.shutil, "which", return_value=None), patch.object(
                graphify_benchmark.Path, "home", return_value=home
            ):
                self.assertEqual(graphify_benchmark._resolve_rtk(), str(exe.resolve()))

    def test_benchmark_requires_rtk_and_never_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(graphify_benchmark.shutil, "which", return_value=None), patch.object(
                graphify_benchmark.Path, "home", return_value=Path(tmp)
            ):
                with self.assertRaisesRegex(RuntimeError, "install RTK.*--rtk"):
                    graphify_benchmark._resolve_rtk()

    def test_freshness_check_rejects_modified_indexed_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "plugin/scripts/one.py"
            source.parent.mkdir(parents=True)
            source.write_text("before\n", encoding="utf-8")
            state = root / "state"
            state.mkdir()
            old_manifest = graphify_code._manifest(root)
            (state / "manifest.json").write_text(json.dumps(old_manifest), encoding="utf-8")
            source.write_text("after\n", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "rebuild required: plugin/scripts/one.py"):
                graphify_code._check_fresh(root, state)

    def test_corpus_rejects_symlinked_file_or_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            private = root / "private.py"
            private.write_text("secret\n", encoding="utf-8")
            target_dir = root / "plugin/scripts"
            target_dir.mkdir(parents=True)
            link = target_dir / "aliased.py"
            try:
                link.symlink_to(private)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"Symlink creation unavailable on this filesystem: {exc}")
            with self.assertRaisesRegex(RuntimeError, "link or reparse point"):
                graphify_code._corpus(root)

    def test_corpus_rejects_junctioned_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            private = root / "private/scripts"
            private.mkdir(parents=True)
            (private / "secret.py").write_text("secret\n", encoding="utf-8")
            (root / "plugin").parent.mkdir(parents=True, exist_ok=True)
            self._junction(root / "plugin", root / "private")
            with self.assertRaisesRegex(RuntimeError, "link or reparse point"):
                graphify_code._corpus(root)

    def test_failed_build_preserves_active_index_and_unrelated_sentinel(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "plugin/scripts/one.py"
            source.parent.mkdir(parents=True)
            source.write_text("pass\n", encoding="utf-8")
            release = root / "scripts/build_release.py"
            release.parent.mkdir(parents=True)
            release.write_text("pass\n", encoding="utf-8")
            state = root / ".agent/graphify-20261020/worker/indexes/check"
            old_run = state / "runs/previous"
            old_run.mkdir(parents=True)
            (old_run / "sentinel.txt").write_text("preserve", encoding="utf-8")
            active = state / "active.json"
            active.write_text(json.dumps({"run": "runs/previous"}), encoding="utf-8")

            with patch.object(graphify_code.importlib.metadata, "version", return_value="0.9.92"), patch.object(
                graphify_code, "_run", return_value=subprocess.CompletedProcess([], 1, "", "synthetic failure")
            ):
                with self.assertRaisesRegex(RuntimeError, "Graphify extraction failed"):
                    graphify_code.build(root, state)

            self.assertEqual(json.loads(active.read_text(encoding="utf-8")), {"run": "runs/previous"})
            self.assertEqual((old_run / "sentinel.txt").read_text(encoding="utf-8"), "preserve")

    def test_missing_index_has_actionable_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError, "run build first"):
                graphify_code._check_fresh(Path(tmp), Path(tmp) / "missing-state")

    def test_state_directory_cannot_escape_owned_worker_area(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(ValueError, "named child"):
                graphify_code._state(root, str(root / "unrelated"))

    def test_state_path_rejects_symlinked_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            indexes = root / ".agent/graphify-20261020/worker/indexes"
            indexes.mkdir(parents=True)
            target = root / "elsewhere"
            target.mkdir()
            try:
                (indexes / "alias").symlink_to(target, target_is_directory=True)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"Directory symlink creation unavailable on this filesystem: {exc}")
            with self.assertRaisesRegex(ValueError, "symbolic link or reparse point"):
                graphify_code._state(root, "alias")

    def test_state_path_rejects_junctioned_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            indexes = root / ".agent/graphify-20261020/worker/indexes"
            indexes.mkdir(parents=True)
            target = root / "elsewhere"
            target.mkdir()
            self._junction(indexes / "alias", target)
            with self.assertRaisesRegex(ValueError, "symbolic link or reparse point"):
                graphify_code._state(root, "alias")

    def test_query_exit_code_propagates_from_graphify(self):
        with patch.object(graphify_code.sys, "argv", ["graphify_code.py", "query", "no match"]), patch.object(
            graphify_code, "query", return_value={"exit_code": 4, "output": ""}
        ):
            self.assertEqual(graphify_code.main(), 4)

    def test_queries_batch_fails_if_any_graphify_query_fails(self):
        results = iter(({"exit_code": 0, "output": "ok"}, {"exit_code": 4, "output": "no match"}))
        with patch.object(graphify_code.sys, "argv", ["graphify_code.py", "queries"]), patch.object(
            graphify_code, "query", side_effect=lambda *args, **kwargs: next(results)
        ), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(graphify_code.main(), 2)

    def test_benchmark_persists_query_failure_and_returns_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for rel in {"scripts/build_release.py", *graphify_code.QUESTIONS["Q1"]["expected"], *graphify_code.QUESTIONS["Q2"]["expected"]}:
                path = root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("pass\n", encoding="utf-8")
            state = root / ".agent/graphify-20261020/worker/indexes/benchmarks/pair"
            results = iter(({"exit_code": 0, "output": ""}, {"exit_code": 4, "output": "missing"}))
            argv = ["graphify_benchmark.py", "--root", str(root), "--state-dir", "benchmarks/pair"]
            with patch.object(graphify_benchmark.graphify_code.sys, "argv", argv), patch.object(
                graphify_benchmark.graphify_code, "build", return_value={"elapsed_ms": 1, "nodes": 1, "edges": 0}
            ), patch.object(
                graphify_benchmark.graphify_code, "query", side_effect=lambda *args, **kwargs: next(results)
            ), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(graphify_benchmark.main(), 2)

            result = json.loads((state / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(result["queries"]["Q2"]["graphify_status"], "error")
            self.assertEqual(result["queries"]["Q2"]["graphify_exit_code"], 4)
            after = json.loads((state / "after.json").read_text(encoding="utf-8"))
            self.assertEqual(after["queries"]["Q2"]["status"], "error")

    def test_active_pointer_rejects_junction_alias_run_before_resolution(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / ".agent/graphify-20261020/worker/indexes/check"
            actual = state / "runs/actual"
            actual.mkdir(parents=True)
            self._junction(state / "runs/alias", actual)
            (state / "active.json").write_text(json.dumps({"run": "runs/alias"}), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "link or reparse point"):
                graphify_code._active_run(state)

    def test_manifest_reader_rejects_junctioned_run_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / ".agent/graphify-20261020/worker/indexes/check"
            actual = state / "runs/actual"
            actual.mkdir(parents=True)
            (actual / "manifest.json").write_text("[]", encoding="utf-8")
            alias = state / "runs/alias"
            self._junction(alias, actual)
            with self.assertRaisesRegex(RuntimeError, "link or reparse point"):
                graphify_code._read_manifest(alias)

    def test_graph_checker_rejects_junctioned_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / "run"
            target = root / "external"
            (run / "out").mkdir(parents=True)
            target.mkdir()
            (target / "graph.json").write_text("{}", encoding="utf-8")
            self._junction(run / "out/graphify-out", target)
            with self.assertRaisesRegex(RuntimeError, "link or reparse point"):
                graphify_code._checked_graph(run)

    def test_manifest_and_graph_files_reject_symlinks_when_supported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / "run"
            run.mkdir()
            manifest_target = root / "manifest-target.json"
            manifest_target.write_text("[]", encoding="utf-8")
            try:
                (run / "manifest.json").symlink_to(manifest_target)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"Symlink creation unavailable on this filesystem: {exc}")
            with self.assertRaisesRegex(RuntimeError, "link or reparse point"):
                graphify_code._read_manifest(run)

            graph_dir = run / "out/graphify-out"
            graph_dir.mkdir(parents=True)
            graph_target = root / "graph-target.json"
            graph_target.write_text("{}", encoding="utf-8")
            (graph_dir / "graph.json").symlink_to(graph_target)
            with self.assertRaisesRegex(RuntimeError, "link or reparse point"):
                graphify_code._checked_graph(run)


if __name__ == "__main__":
    unittest.main()
