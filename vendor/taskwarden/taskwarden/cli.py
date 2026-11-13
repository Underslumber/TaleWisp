"""Command line interface for local TaskWarden operations."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import subprocess
from pathlib import Path
from typing import Any

from .adapters import HookCycleStore, bound_session_id, incomplete_yield_response, native, translate, unbound_response
from .core import Controller, WardenError
from .supervisor import review as semantic_review
from .control_plane import guard_pretool, validate_control_plane_paths


def _json_input(path: str) -> Any:
    raw = Path(path).read_text(encoding="utf-8") if path != "-" else sys.stdin.read()
    return json.loads(raw)


def _token(path: str) -> str:
    value = Path(path).read_text(encoding="utf-8").strip()
    if not value: raise WardenError("empty capability file")
    return value


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="taskwarden")
    p.add_argument("--db", required=True, help="SQLite database path")
    p.add_argument("--workspace", required=True, help="authorized local workspace root")
    sub = p.add_subparsers(dest="command", required=True)
    c = sub.add_parser("create"); c.add_argument("--task", required=True); c.add_argument("--requirements", required=True); c.add_argument("--budget", type=int, default=12)
    a = sub.add_parser("amend"); a.add_argument("--task", required=True); a.add_argument("--token-file", required=True); a.add_argument("--version", type=int, required=True); a.add_argument("--requirements", required=True)
    s = sub.add_parser("status"); s.add_argument("--task", required=True); s.add_argument("--role", choices=["owner", "executor", "reviewer"], required=True); s.add_argument("--token-file", required=True)
    hist = sub.add_parser("history"); hist.add_argument("--task", required=True); hist.add_argument("--token-file", required=True)
    e = sub.add_parser("evidence"); e.add_argument("--task", required=True); e.add_argument("--token-file", required=True); e.add_argument("--version", type=int, required=True); e.add_argument("--criterion", required=True); e.add_argument("--file", required=True); e.add_argument("--note", required=True)
    r = sub.add_parser("review"); r.add_argument("--task", required=True); r.add_argument("--token-file", required=True); r.add_argument("--version", type=int, required=True); r.add_argument("--fingerprint", required=True); r.add_argument("--criterion", required=True); r.add_argument("--verdict", choices=["ACCEPT", "REJECT"], required=True); r.add_argument("--note", required=True)
    d = sub.add_parser("control"); d.add_argument("--task", required=True); d.add_argument("--token-file", required=True); d.add_argument("--version", type=int, required=True); d.add_argument("--role", choices=["owner", "executor"], required=True); d.add_argument("--event", choices=["checkpoint", "completion_request", "owner_pause", "owner_cancel", "investigate", "owner_resume"], required=True); d.add_argument("--payload", default="{}")
    h = sub.add_parser("hook"); h.add_argument("--task", required=True); h.add_argument("--token-file", required=True); h.add_argument("--role", choices=["owner", "executor", "reviewer"], required=True); h.add_argument("--platform", choices=["codex", "claude", "gemini"], required=True); h.add_argument("--session-id")
    sr = sub.add_parser("supervise"); sr.add_argument("--task", required=True); sr.add_argument("--version", type=int, required=True); sr.add_argument("--token-file", required=True); sr.add_argument("--context", required=True); sr.add_argument("--run-dir", required=True); sr.add_argument("--adapter")
    hc = sub.add_parser("hook-config"); hc.add_argument("--task", required=True); hc.add_argument("--session-id", required=True, help="native session identity to bind this generated hook to"); hc.add_argument("--platform", choices=["codex", "claude", "gemini"], required=True); hc.add_argument("--executor-token-file", required=True); hc.add_argument("--reviewer-token-file", required=True); hc.add_argument("--context", required=True); hc.add_argument("--run-dir", required=True); hc.add_argument("--adapter"); hc.add_argument("--control-plane-runtime-root"); hc.add_argument("--control-plane-state-root")
    cg = sub.add_parser("control-plane-guard"); cg.add_argument("--session-id", required=True); cg.add_argument("--platform", choices=["codex", "claude", "gemini"], required=True); cg.add_argument("--control-plane-runtime-root", required=True); cg.add_argument("--control-plane-state-root", required=True)
    sh = sub.add_parser("supervised-hook"); sh.add_argument("--task", required=True); sh.add_argument("--session-id"); sh.add_argument("--executor-token-file", required=True); sh.add_argument("--reviewer-token-file", required=True); sh.add_argument("--context", required=True); sh.add_argument("--run-dir", required=True); sh.add_argument("--platform", choices=["codex", "claude", "gemini"], required=True); sh.add_argument("--adapter")
    launch = sub.add_parser("dispatch"); launch.add_argument("--task", required=True); launch.add_argument("--token-file", required=True); launch.add_argument("--version", type=int, required=True); launch.add_argument("--request", required=True); launch.add_argument("--run-dir", required=True)
    return p


def run(args: argparse.Namespace, hook_data: Any = None, review_runner: Any = None) -> Any:
    if args.command == "control-plane-guard":
        event = hook_data.get("hook_event_name") if isinstance(hook_data, dict) else None
        actual = bound_session_id(args.platform, hook_data)
        if not actual or actual != args.session_id:
            return unbound_response(args.platform, event, "TaskWarden control-plane guard belongs to another session; no control action was authorized.")
        runtime, state = validate_control_plane_paths(args.workspace, args.control_plane_runtime_root,
                                                       args.control_plane_state_root)
        return guard_pretool(args.platform, hook_data, workspace=args.workspace,
                             runtime_root=runtime, state_root=state)
    if args.command in {"hook", "supervised-hook"}:
        event = hook_data.get("hook_event_name") if isinstance(hook_data, dict) else None
        binding = getattr(args, "session_id", None)
        if not binding:
            return unbound_response(args.platform, event, "TaskWarden legacy hook has no session binding; this event was not enforced. Regenerate and trust a session-bound hook.")
        else:
            actual = bound_session_id(args.platform, hook_data)
            if actual is None:
                raise WardenError("bound hook input is missing its native session identity; callback cannot prove applicability")
            if actual != binding:
                return unbound_response(args.platform, event, "TaskWarden hook belongs to another native session; this event was ignored.")
            if event in {"UserPromptSubmit", "BeforeAgent"}:
                store = HookCycleStore(args.run_dir if args.command == "supervised-hook" else Path(args.db).resolve().parent)
                store.clear(args.task, binding)
    if args.command != "create" and not Path(args.db).is_file():
        raise WardenError("database does not exist; use create only with the intended database path")
    ctrl = Controller(args.db, args.workspace, create_workspace=args.command == "create")
    try:
        cmd = args.command
        if cmd == "create":
            req = _json_input(args.requirements)
            return {"task": args.task, "capabilities": ctrl.create(args.task, req, req.get("scope") if isinstance(req, dict) else [], args.budget), "warning": "Store each capability outside the executor workspace. Capabilities are application-level, not OS isolation."}
        if cmd == "amend": return ctrl.amend(args.task, _token(args.token_file), args.version, _json_input(args.requirements))
        if cmd == "status": return ctrl.status(args.task, _token(args.token_file), args.role)
        if cmd == "history": return ctrl.history(args.task, _token(args.token_file))
        if cmd == "dispatch":
            from .dispatch import dispatch
            from .native_dispatch import launcher
            return dispatch(ctrl,args.task,_token(args.token_file),args.version,_json_input(args.request),launcher(Path(args.run_dir).resolve()))
        if cmd == "evidence": return ctrl.evidence_add(args.task, _token(args.token_file), args.version, args.criterion, args.file, args.note)
        if cmd == "review": return ctrl.review_add(args.task, _token(args.token_file), args.version, args.fingerprint, args.criterion, args.verdict, args.note)
        if cmd == "control": return ctrl.decide(args.task, args.role, _token(args.token_file), args.event, json.loads(args.payload), args.version)
        if cmd == "hook":
            event = hook_data.get("hook_event_name") if isinstance(hook_data, dict) else None
            store = HookCycleStore(Path(args.db).resolve().parent)
            status = None
            if event in {"Stop", "AfterAgent"}:
                status = ctrl.status(args.task, _token(args.token_file), args.role)
                if status["state"] in {"BLOCKED", "INVESTIGATION"}:
                    if not store.claim_or_observe(args.task, args.session_id):
                        return incomplete_yield_response(args.platform, status["state"], "The bounded diagnostic continuation has been used; report the blocker and wait for the owner.")
                    return native(args.platform, "completion_request", {"decision": status["state"], "reason": "Task remains incomplete. Perform one bounded diagnosis, identify the owner action, and do not repeat expensive checks."})
            result = translate(args.platform, ctrl, args.task, args.role, _token(args.token_file), hook_data, raise_errors=True)
            if event in {"Stop", "AfterAgent"}:
                after = ctrl.status(args.task, _token(args.token_file), args.role)
                blocked = result.get("decision") == ("deny" if args.platform == "gemini" else "block")
                if blocked and after["state"] in {"BLOCKED", "INVESTIGATION"} and not store.claim_or_observe(args.task, args.session_id):
                    return incomplete_yield_response(args.platform, after["state"], "The bounded diagnostic continuation has been used; report the blocker and wait for the owner.")
            return result
        if cmd == "supervise": return semantic_review(ctrl, args.task, _token(args.token_file), args.context, args.run_dir, args.version, args.adapter, review_runner)
        if cmd == "hook-config":
            package_root = str(Path(__file__).resolve().parent.parent)
            bootstrap = f"import sys;sys.path.insert(0,{package_root!r});from taskwarden.cli import main;main()"
            cmdline = [sys.executable, "-I", "-c", bootstrap, "--db", str(Path(args.db).resolve()), "--workspace", str(Path(args.workspace).resolve()), "supervised-hook", "--task", args.task, "--session-id", args.session_id, "--executor-token-file", str(Path(args.executor_token_file).resolve()), "--reviewer-token-file", str(Path(args.reviewer_token_file).resolve()), "--context", str(Path(args.context).resolve()), "--run-dir", str(Path(args.run_dir).resolve()), "--platform", args.platform]
            if args.adapter: cmdline.extend(["--adapter", str(Path(args.adapter).resolve())])
            command = subprocess.list2cmdline(cmdline)
            if bool(args.control_plane_runtime_root) != bool(args.control_plane_state_root):
                raise WardenError("both control-plane runtime and state roots are required")
            if args.control_plane_runtime_root:
                validate_control_plane_paths(args.workspace, args.control_plane_runtime_root,
                                              args.control_plane_state_root)
            guard_command = None
            if args.control_plane_runtime_root:
                guard_args = [sys.executable, "-I", "-c", bootstrap, "--db", str(Path(args.db).resolve()), "--workspace", str(Path(args.workspace).resolve()), "control-plane-guard", "--session-id", args.session_id, "--platform", args.platform, "--control-plane-runtime-root", str(Path(args.control_plane_runtime_root).resolve()), "--control-plane-state-root", str(Path(args.control_plane_state_root).resolve())]
                guard_command = subprocess.list2cmdline(guard_args)
            if args.platform in {"codex", "claude"}:
                hooks = {"Stop": [{"hooks": [{"type": "command", "command": command}]}], "SubagentStop": [{"hooks": [{"type": "command", "command": command}]}], "UserPromptSubmit": [{"hooks": [{"type": "command", "command": command}]}]}
                if guard_command: hooks["PreToolUse"] = [{"hooks": [{"type": "command", "command": guard_command}]}]
                return {"hooks": hooks}
            hooks = {"AfterAgent": [{"hooks": [{"name": "taskwarden-supervisor", "type": "command", "command": command}]}], "BeforeAgent": [{"hooks": [{"name": "taskwarden-session-reset", "type": "command", "command": command}]}]}
            if guard_command: hooks["BeforeTool"] = [{"hooks": [{"name": "taskwarden-control-plane-guard", "type": "command", "command": guard_command}]}]
            return {"hooks": hooks}
        if cmd == "supervised-hook":
            event = hook_data.get("hook_event_name") if isinstance(hook_data, dict) else None
            store = HookCycleStore(args.run_dir)
            st = ctrl.status(args.task, _token(args.executor_token_file), "executor")
            if event in {"Stop", "AfterAgent"} and st["state"] in {"BLOCKED", "INVESTIGATION"}:
                if not store.claim_or_observe(args.task, args.session_id):
                    return incomplete_yield_response(args.platform, st["state"], "The bounded diagnostic continuation has been used; report the blocker and wait for the owner.")
                return native(args.platform, "completion_request", {"decision": st["state"], "reason": "Task remains incomplete. Perform one bounded diagnosis, identify the owner action, and do not repeat expensive checks."})
            if event in {"Stop", "AfterAgent"} and st["state"] in {"ACTIVE", "ACCEPTED"}:
                evidence = [e for e in st["evidence"] if e["version"] == st["version"]]
                mandatory = [c["id"] for c in st["requirements"]["criteria"] if c["mandatory"]]
                if evidence and all(any(e["criterion"] == cid for e in evidence) for cid in mandatory):
                    semantic_review(ctrl, args.task, _token(args.reviewer_token_file), args.context, args.run_dir, st["version"], args.adapter, review_runner)
            result = translate(args.platform, ctrl, args.task, "executor", _token(args.executor_token_file), hook_data, raise_errors=True)
            if event in {"Stop", "AfterAgent"}:
                after = ctrl.status(args.task, _token(args.executor_token_file), "executor")
                blocked = result.get("decision") == ("deny" if args.platform == "gemini" else "block")
                if blocked and after["state"] in {"BLOCKED", "INVESTIGATION"} and not store.claim_or_observe(args.task, args.session_id):
                    return incomplete_yield_response(args.platform, after["state"], "The bounded diagnostic continuation has been used; report the blocker and wait for the owner.")
            return result
        raise WardenError("unknown command")
    finally: ctrl.close()


def main(review_runner: Any = None) -> None:
    args = parser().parse_args()
    raw = None
    hook_data = None
    try:
        if args.command in {"hook", "supervised-hook", "control-plane-guard"}:
            raw = sys.stdin.read()
            hook_data = json.loads(raw)
        result = run(args, hook_data, review_runner)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    except Exception as exc:
        if args.command in {"hook", "supervised-hook", "control-plane-guard"}:
            if args.command == "control-plane-guard":
                print(json.dumps(native(args.platform, "pretool", {"decision": "deny", "reason": "TaskWarden control-plane guard failed closed; inspect the controller error locally."}), ensure_ascii=False, sort_keys=True))
                return
            from .adapters import hook_error_response
            event_name = hook_data.get("hook_event_name") if isinstance(hook_data, dict) else None
            if hook_data is None and raw:
                import re
                match = re.search(r'"hook_event_name"\s*:\s*"([^"]+)"', raw)
                if match: event_name = match.group(1)
            binding = getattr(args, "session_id", None)
            actual = None
            try:
                if binding: actual = bound_session_id(args.platform, hook_data)
            except WardenError: pass
            if not binding:
                out = unbound_response(args.platform, event_name, "TaskWarden legacy hook has no session binding; this event was not enforced. Regenerate and trust a session-bound hook.")
            elif (actual is None or actual == binding) and event_name in {"Stop", "AfterAgent"}:
                try:
                    store = HookCycleStore(args.run_dir if args.command == "supervised-hook" else Path(args.db).resolve().parent)
                    if not store.claim_or_observe(args.task, binding):
                        out = incomplete_yield_response(args.platform, "UNKNOWN", "TaskWarden still reports a callback error; inspect it locally before resuming.")
                    else:
                        from .adapters import hook_error_response
                        out = hook_error_response(args.platform, event_name, args.task, args.db, args.workspace)
                except Exception:
                    out = incomplete_yield_response(args.platform, "UNKNOWN", "TaskWarden could not persist retry state; callback error remains visible in the local error output.")
            else:
                from .adapters import hook_error_response
                out = hook_error_response(args.platform, event_name, args.task, args.db, args.workspace)
            print(json.dumps(out, ensure_ascii=False, sort_keys=True))
            return
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__": main()
