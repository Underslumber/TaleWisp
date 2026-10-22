"""Run fixed before/after code-navigation lookups on one immutable corpus snapshot."""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import time
import uuid

SPEC = importlib.util.spec_from_file_location("graphify_code", Path(__file__).with_name("graphify_code.py"))
graphify_code = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(graphify_code)

SEARCHES = {
    "Q1": [r"provenance.get\('completeness'\)|def extract\(|completeness.*True"],
    "Q2": [r"build_series_base\(request\)|talewisp_build_series_base|def main\(", "build_series_base"],
}


def _resolve_rtk(configured: str | None = None) -> str:
    if configured:
        found = shutil.which(configured)
        candidate = Path(configured).expanduser()
        if found:
            return found
        if candidate.is_file():
            return str(candidate.resolve())
        raise RuntimeError(f"Configured RTK executable not found: {configured}")
    for name in ("rtk", "rtk.exe"):
        found = shutil.which(name)
        if found:
            return found
    local = Path.home() / ".local/bin/rtk.exe"
    if local.is_file():
        return str(local.resolve())
    raise RuntimeError("RTK executable not found; install RTK, add it to PATH, or pass --rtk <path>")


def _relative_matches(output: str, expected: list[str]) -> list[str]:
    text = output.replace("\\", "/")
    return [path for path in expected if path in text]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--state-dir", default=f"benchmarks/{uuid.uuid4().hex}", help="unique name under .agent/graphify-20261020/worker/indexes")
    parser.add_argument("--budget", type=int, default=500)
    parser.add_argument("--rtk", help="explicit RTK executable path or command name")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    try:
        state = graphify_code._state(root, args.state_dir)
        rtk = _resolve_rtk(args.rtk)
        state.mkdir(parents=True, exist_ok=False)
        source = state / "source"
        source.mkdir()
        manifest = graphify_code._manifest(root)
        for entry in manifest:
            relative = Path(str(entry["path"]))
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            graphify_code._reject_linked_path(root, root / relative)
            with (root / relative).open("rb") as reader, target.open("xb") as writer:
                writer.write(reader.read())
        (state / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        baseline: dict[str, object] = {"manifest_sha256": graphify_code._hash(state / "manifest.json"), "files": len(manifest), "bytes": sum(int(row["bytes"]) for row in manifest), "queries": {}}
        for qid, spec in graphify_code.QUESTIONS.items():
            target_paths = spec["expected"]
            all_results = []
            for pattern in SEARCHES[qid]:
                cmd = [rtk, "rg", "--max-columns", "500", "--max-columns-preview", "-n", pattern, *[str(source / path) for path in target_paths]]
                started = time.perf_counter()
                result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
                elapsed = (time.perf_counter() - started) * 1000
                output = result.stdout + result.stderr
                all_results.append({"command": cmd, "exit_code": result.returncode, "elapsed_ms": round(elapsed, 3), "output_chars": len(output), "output": output})
                if result.returncode not in (0, 1):
                    raise RuntimeError(f"Baseline search failed ({result.returncode}): {result.stderr}")
            combined = "\n".join(str(item["output"]) for item in all_results)
            baseline["queries"][qid] = {"question": spec["question"], "expected_files": target_paths, "found_files": _relative_matches(combined, target_paths), "elapsed_ms": round(sum(float(item["elapsed_ms"]) for item in all_results), 3), "output_chars": sum(int(item["output_chars"]) for item in all_results), "steps": all_results}
        (state / "baseline.json").write_text(json.dumps(baseline, ensure_ascii=False, indent=2), encoding="utf-8")

        build_result = graphify_code.build(root, state, reuse_staged=True)
        (state / "build.json").write_text(json.dumps(build_result, ensure_ascii=False, indent=2), encoding="utf-8")
        after: dict[str, object] = {"queries": {}}
        for qid, spec in graphify_code.QUESTIONS.items():
            try:
                result = graphify_code.query(root, state, str(spec["question"]), budget=args.budget)
            except (OSError, ValueError, RuntimeError) as exc:
                result = {"exit_code": 2, "output": "", "error": str(exc)}
            output = str(result.get("output", ""))
            code = int(result.get("exit_code", 2))
            after["queries"][qid] = {"question": spec["question"], "expected_files": spec["expected"], "found_files": _relative_matches(output, spec["expected"]), "status": "ok" if code == 0 else "error", **result}
        (state / "after.json").write_text(json.dumps(after, ensure_ascii=False, indent=2), encoding="utf-8")
        summary = {"corpus_files": baseline["files"], "corpus_bytes": baseline["bytes"], "manifest_sha256": baseline["manifest_sha256"], "extract_elapsed_ms": build_result["elapsed_ms"], "nodes": build_result["nodes"], "edges": build_result["edges"], "queries": {}}
        for qid in graphify_code.QUESTIONS:
            b = baseline["queries"][qid]
            a = after["queries"][qid]
            summary["queries"][qid] = {"baseline_ms": b["elapsed_ms"], "baseline_chars": b["output_chars"], "baseline_found": b["found_files"], "graphify_status": a["status"], "graphify_exit_code": a["exit_code"], "graphify_ms": a.get("elapsed_ms"), "graphify_chars": a.get("output_chars"), "graphify_found": a["found_files"], "error": a.get("error")}
        (state / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"state": str(state), **summary}, ensure_ascii=False, indent=2))
        return 2 if any(row["graphify_exit_code"] != 0 for row in summary["queries"].values()) else 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=__import__("sys").stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
