#!/usr/bin/env python3
"""Build and query a private, code-only Graphify index for the public project sources.

The source allowlist is intentionally narrow and excludes all vaults, documents,
local plugin copies, and generated/runtime directories. Graph results are
navigation hints; callers should read the original files before relying on them.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid


VERSION = "graphifyy==0.9.92"
EXCLUDED = {"scripts/graphify_code.py", "scripts/graphify_benchmark.py", "tests/publication/test_graphify_code.py", "scripts/export_public.py"}
QUESTIONS = {
    "Q1": {
        "question": "Which function checks source completeness before extracting text, images, and media, and which publication test exercises that gate?",
        "expected": ["plugin/scripts/source_adapters.py", "tests/publication/test_source_adapters.py"],
    },
    "Q2": {
        "question": "How does the series base CLI route its request to the importer, and which public MCP test covers the exposed operation?",
        "expected": ["plugin/scripts/series_base_cli.py", "plugin/scripts/series_import.py", "plugin/scripts/talewisp_mcp.py", "tests/publication/test_publication.py"],
    },
}


def _hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_link_or_reparse(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    reparse_flag = getattr(info, "st_file_attributes", 0) & 0x400
    if sys.platform == "win32":
        attributes = ctypes.windll.kernel32.GetFileAttributesW(str(path))
        if attributes != 0xFFFFFFFF:
            reparse_flag = reparse_flag or (attributes & 0x400)
    return path.is_symlink() or bool(reparse_flag) or bool(getattr(path, "is_junction", lambda: False)())


def _reject_linked_path(root: Path, path: Path) -> None:
    root = root.absolute()
    path = path.absolute()
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise RuntimeError(f"Path escapes project root: {path}") from exc
    current = root
    for part in (None, *relative.parts):
        if part is not None:
            current = current / part
        if _is_link_or_reparse(current):
            raise RuntimeError(f"Symbolic link or reparse point is not allowed in indexed paths: {current}")
    if not path.resolve().is_relative_to(root.resolve()):
        raise RuntimeError(f"Resolved path escapes project root: {path}")


def _corpus(root: Path) -> list[Path]:
    root = root.resolve()
    paths = [*root.joinpath("plugin/scripts").glob("*.py"), *root.joinpath("tests/publication").glob("*.py"), root / "scripts/build_release.py"]
    selected = sorted((p for p in paths if p.is_file() and p.relative_to(root).as_posix() not in EXCLUDED), key=lambda p: p.relative_to(root).as_posix())
    for path in selected:
        _reject_linked_path(root, path)
    return selected


def _manifest(root: Path) -> list[dict[str, object]]:
    return [{"path": p.relative_to(root).as_posix(), "sha256": _hash(p), "bytes": p.stat().st_size} for p in _corpus(root)]


def _state(root: Path, requested: str | None) -> Path:
    root = root.resolve()
    allowed = root / ".agent/graphify-20261020/worker/indexes"
    candidate = Path(requested) if requested is not None else Path("default")
    if not candidate.is_absolute():
        candidate = allowed / candidate
    candidate = candidate.absolute()
    try:
        relative = candidate.relative_to(allowed)
    except ValueError as exc:
        raise ValueError(f"State directory must be a named child of {allowed}") from exc
    if not relative.parts or any(part in {".", ".."} for part in relative.parts):
        raise ValueError(f"State directory must be a named child of {allowed}")
    current = root
    for part in Path(".agent/graphify-20261020/worker/indexes").parts + relative.parts:
        current = current / part
        if _is_link_or_reparse(current):
            raise ValueError(f"State path cannot contain a symbolic link or reparse point: {current}")
    resolved = candidate.resolve()
    if not resolved.is_relative_to(allowed.resolve()):
        raise ValueError(f"Resolved state directory escapes {allowed}")
    candidate = resolved
    return candidate


def _reject_state_links(root: Path, path: Path) -> None:
    root = root.absolute()
    path = path.absolute()
    if _is_link_or_reparse(root):
        raise RuntimeError(f"Generated state cannot contain a symbolic link or reparse point: {root}")
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise RuntimeError(f"Generated state escapes its owned index directory: {path}") from exc
    if any(part in {".", ".."} for part in relative.parts):
        raise RuntimeError(f"Generated state path contains traversal: {path}")
    current = root
    for part in relative.parts:
        current = current / part
        if _is_link_or_reparse(current):
            raise RuntimeError(f"Generated state cannot contain a symbolic link or reparse point: {current}")


def _active_run(state: Path) -> Path:
    _reject_state_links(state, state / "active.json")
    active_file = state / "active.json"
    if not active_file.is_file():
        raise RuntimeError(f"No Graphify index at {active_file}; run build first")
    try:
        relative = Path(json.loads(active_file.read_text(encoding="utf-8"))["run"])
        if relative.is_absolute() or relative.parts[:1] != ("runs",) or len(relative.parts) < 2:
            raise ValueError("run must name a child of runs/")
        lexical_run = state / relative
        _reject_state_links(state, lexical_run)
        run = lexical_run.resolve()
        run.relative_to((state / "runs").resolve())
    except (OSError, KeyError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("Graphify active-run pointer is invalid; rebuild the index") from exc
    if not run.is_dir():
        raise RuntimeError("Graphify active index run is missing; rebuild the index")
    _reject_state_links(state, run)
    return run


def _read_manifest(run: Path) -> list[dict[str, object]]:
    path = run / "manifest.json"
    _reject_state_links(run, path)
    if not path.is_file():
        raise RuntimeError(f"No Graphify index manifest at {path}; run build first")
    return json.loads(path.read_text(encoding="utf-8"))


def _check_fresh(root: Path, run: Path) -> list[dict[str, object]]:
    expected = _read_manifest(run)
    current = _manifest(root)
    if current != expected:
        old = {entry["path"]: entry["sha256"] for entry in expected}
        new = {entry["path"]: entry["sha256"] for entry in current}
        changed = sorted(path for path in old.keys() | new.keys() if old.get(path) != new.get(path))
        raise RuntimeError("Indexed source changed; rebuild required: " + ", ".join(changed[:12]))
    return current


def _graph(state: Path) -> Path:
    return state / "out/graphify-out/graph.json"


def _checked_graph(run: Path) -> Path:
    graph = _graph(run)
    _reject_state_links(run, graph)
    return graph


def _run(cmd: list[str], *, timeout: int = 300) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except FileNotFoundError as exc:
        raise RuntimeError(f"Graphify executable unavailable ({exc}); install {VERSION} in an isolated environment") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"Graphify exceeded {timeout}s timeout") from exc


def _graphify() -> list[str]:
    return [sys.executable, "-m", "graphify"]


def _check_version() -> None:
    expected = VERSION.split("==", 1)[1]
    try:
        actual = importlib.metadata.version("graphifyy")
    except importlib.metadata.PackageNotFoundError as exc:
        raise RuntimeError(f"Graphify is not installed; install {VERSION} in the isolated environment") from exc
    if actual != expected:
        raise RuntimeError(f"Expected {VERSION}; found graphifyy=={actual}")


def build(root: Path, state: Path, *, reuse_staged: bool = False) -> dict[str, object]:
    _check_version()
    live_manifest = _manifest(root)
    manifest = live_manifest
    if not manifest:
        raise RuntimeError("Allowlisted technical corpus is empty")
    # Each extraction is immutable. A failed build never overwrites or removes
    # the prior active graph or its evidence.
    run = state / "runs" / uuid.uuid4().hex
    source = run / "source"
    out = run / "out"
    _reject_state_links(state, run)
    run.mkdir(parents=True, exist_ok=False)
    if reuse_staged:
        staged_manifest = json.loads((state / "manifest.json").read_text(encoding="utf-8"))
        if staged_manifest != manifest:
            raise RuntimeError("Staged manifest differs from live allowlisted sources")
        staged_source = state / "source"
        for entry in manifest:
            rel = Path(str(entry["path"]))
            original = staged_source / rel
            _reject_state_links(state, original)
            if not original.is_file() or _hash(original) != entry["sha256"]:
                raise RuntimeError(f"Staged source hash mismatch: {rel}")
        manifest = staged_manifest
        source.mkdir(parents=True)
        for entry in manifest:
            rel = Path(str(entry["path"]))
            target = source / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            with (staged_source / rel).open("rb") as reader, target.open("xb") as writer:
                writer.write(reader.read())
    else:
        source.mkdir(parents=True)
        for entry in manifest:
            rel = Path(str(entry["path"]))
            target = source / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            _reject_linked_path(root, root / rel)
            with (root / rel).open("rb") as reader, target.open("xb") as writer:
                writer.write(reader.read())
            if _hash(target) != entry["sha256"]:
                raise RuntimeError(f"Staged source hash mismatch: {rel}")
    started = time.perf_counter()
    cmd = _graphify() + ["extract", str(source), "--code-only", "--no-cluster", "--out", str(out)]
    result = _run(cmd, timeout=900)
    if result.returncode:
        raise RuntimeError(f"Graphify extraction failed ({result.returncode}): {(result.stderr or result.stdout)[-3000:]}")
    graph = _checked_graph(run)
    if not graph.is_file():
        raise RuntimeError(f"Graphify succeeded without expected graph file: {graph}")
    (run / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    data = json.loads(graph.read_text(encoding="utf-8"))
    state.mkdir(parents=True, exist_ok=True)
    _reject_state_links(state, state / "active.json")
    pointer = state / "active.json"
    temporary = state / f"active-{uuid.uuid4().hex}.tmp"
    temporary.write_text(json.dumps({"run": str(run.relative_to(state))}, indent=2), encoding="utf-8")
    temporary.replace(pointer)
    return {"files": len(manifest), "bytes": sum(int(x["bytes"]) for x in manifest), "elapsed_ms": round((time.perf_counter() - started) * 1000, 3), "graph": str(graph), "nodes": len(data.get("nodes", [])), "edges": len(data.get("edges", [])), "command": cmd, "stdout": result.stdout[-2000:], "stderr": result.stderr[-2000:]}


def query(root: Path, state: Path, question: str, *, seed: str | None = None, budget: int = 1000) -> dict[str, object]:
    run = _active_run(state)
    _check_fresh(root, run)
    _check_version()
    graph = _checked_graph(run)
    if not graph.is_file():
        raise RuntimeError("Graphify graph missing; run build")
    cmd = _graphify() + ["query", question, "--budget", str(budget), "--graph", str(graph)]
    if seed:
        cmd.extend(["--seed", seed])
    started = time.perf_counter()
    result = _run(cmd, timeout=60)
    out = result.stdout + result.stderr
    out = out.replace(str((run / "source").resolve()), ".")
    return {"command": cmd, "exit_code": result.returncode, "elapsed_ms": round((time.perf_counter() - started) * 1000, 3), "output_chars": len(out), "output": out}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["build", "status", "query", "queries"])
    parser.add_argument("question", nargs="?")
    parser.add_argument("--root", default=".")
    parser.add_argument("--state-dir")
    parser.add_argument("--seed")
    parser.add_argument("--budget", type=int, default=1000)
    parser.add_argument("--reuse-staged", action="store_true", help="extract the exact pre-staged source snapshot after verifying its manifest")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    try:
        state = _state(root, args.state_dir)
        if args.command == "build":
            value = build(root, state, reuse_staged=args.reuse_staged)
        elif args.command == "status":
            run = _active_run(state)
            manifest = _check_fresh(root, run)
            graph = _checked_graph(run)
            if not graph.is_file():
                raise RuntimeError(f"Graphify graph missing at {graph}; run build")
            _check_version()
            value = {"fresh": True, "files": len(manifest), "graph_exists": True, "graph": str(graph)}
        elif args.command == "query":
            if not args.question:
                parser.error("query requires a question")
            value = query(root, state, args.question, seed=args.seed, budget=args.budget)
        else:
            value = {qid: {"question": spec["question"], "expected_files": spec["expected"], **query(root, state, str(spec["question"]), budget=args.budget)} for qid, spec in QUESTIONS.items()}
        print(json.dumps(value, ensure_ascii=False, indent=2))
        if args.command == "query" and value["exit_code"] != 0:
            return int(value["exit_code"])
        if args.command == "queries" and any(item["exit_code"] != 0 for item in value.values()):
            return 2
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
