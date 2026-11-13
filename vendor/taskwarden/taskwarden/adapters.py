"""Native hook protocol translators. Unsupported/ambiguous actions fail closed."""
from __future__ import annotations

import sqlite3
import hashlib
from contextlib import closing
from typing import Any
from pathlib import Path
from .core import Controller, WardenError

READ_TOOLS = {"Read", "Glob", "Grep", "LS", "NotebookRead", "WebSearch", "WebFetch"}
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"}


def _intentional_owner_stop(db: str | Path, workspace: str | Path, task_id: str) -> str | None:
    """Read only the exact persisted task state; failures always mean unknown."""
    connection = None
    try:
        database = Path(db).resolve(strict=True)
        if not database.is_file():
            return None
        uri = database.as_uri() + "?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=0.2)
        row = connection.execute("SELECT state, workspace FROM task WHERE id=?", (task_id,)).fetchone()
        if row is None or Path(row[1]).resolve() != Path(workspace).resolve():
            return None
        return row[0] if row[0] in {"PAUSED", "CANCELLED"} else None
    except (OSError, ValueError, TypeError, RuntimeError, sqlite3.Error):
        return None
    finally:
        if connection is not None:
            connection.close()


def hook_error_response(platform: str, event_name: Any, task_id: str,
                        db: str | Path, workspace: str | Path) -> dict[str, Any]:
    """Build a safe native error response without opening the writable controller."""
    if platform in {"codex", "claude"}:
        if event_name == "PreToolUse":
            return native(platform, "pretool", {"decision": "deny", "reason": "TaskWarden could not verify this request; inspect the controller error locally."})
        if event_name == "UserPromptSubmit":
            return native(platform, "prompt", {"decision": "allow", "reason": "TaskWarden controller error"})
        if event_name == "SubagentStop":
            return native(platform, "subagent_stop", {"decision": "SUBAGENT_STOP", "reason": "Subagent stopped locally; parent task state was not changed."})
    elif platform == "gemini":
        if event_name == "BeforeTool":
            return native(platform, "pretool", {"decision": "deny", "reason": "TaskWarden could not verify this request; inspect the controller error locally."})
        if event_name == "BeforeAgent":
            return native(platform, "prompt", {"decision": "allow", "reason": "TaskWarden controller error"})

    state = _intentional_owner_stop(db, workspace, task_id)
    if state in {"PAUSED", "CANCELLED"}:
        return native(platform, "completion_request", {
            "decision": state,
            "reason": "Task remains intentionally stopped by its owner.",
        })
    return native(platform, "completion_request", {
        "decision": "BLOCKED",
        "reason": "TaskWarden could not verify completion. Inspect the controller error locally, repair the callback, then continue bounded diagnosis; do not claim completion.",
    })


class HookCycleStore:
    """Durable, concurrency-safe one-continuation gate for a bound task/session."""

    def __init__(self, run_dir: str | Path):
        self.path = Path(run_dir) / ".taskwarden-hook-cycles.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.path, timeout=5)
        con.execute("CREATE TABLE IF NOT EXISTS hook_cycle (task_id TEXT NOT NULL, session_id TEXT NOT NULL, pending INTEGER NOT NULL, PRIMARY KEY(task_id, session_id))")
        return con

    def claim_or_observe(self, task_id: str, session_id: str) -> bool:
        """Atomically claim the one continuation; keep the claim until a prompt reset."""
        session_key = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
        with closing(self._connect()) as con:
            with con:
                con.execute("BEGIN IMMEDIATE")
                result = con.execute("INSERT OR IGNORE INTO hook_cycle VALUES(?,?,1)", (task_id, session_key))
                return result.rowcount == 1

    def clear(self, task_id: str, session_id: str) -> None:
        session_key = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
        with closing(self._connect()) as con:
            with con:
                con.execute("DELETE FROM hook_cycle WHERE task_id=? AND session_id=?", (task_id, session_key))


def unbound_response(platform: str, event_name: Any, reason: str) -> dict[str, Any]:
    """Neutral response for an explicit legacy no-binding or a different session."""
    if platform == "codex":
        return {"systemMessage": reason}
    if platform == "claude":
        return {"systemMessage": reason}
    if platform == "gemini" and event_name == "AfterAgent":
        return {"decision": "allow", "systemMessage": reason}
    if platform == "gemini":
        return {"systemMessage": reason}
    raise WardenError("unsupported platform")


def incomplete_yield_response(platform: str, state: str, reason: str) -> dict[str, Any]:
    """Let a terminal/error retry cycle end while explicitly preserving incompleteness."""
    message = f"TaskWarden yielded after one bounded diagnostic continuation. Task state remains {state}; completion was not accepted. {reason}"
    if platform == "gemini":
        return {"decision": "allow", "systemMessage": message}
    return {"systemMessage": message}


def bound_session_id(platform: str, data: Any) -> str | None:
    if platform == "gemini":
        from os import environ
        value = environ.get("GEMINI_SESSION_ID")
        if not value and isinstance(data, dict): value = data.get("session_id")
    else:
        value = data.get("session_id") if isinstance(data, dict) else None
    if value is not None and (not isinstance(value, str) or not value.strip()):
        raise WardenError("hook session identity must be a non-empty string")
    return value


def normalize(platform: str, data: Any) -> tuple[str, dict[str, Any]]:
    if not isinstance(data, dict): raise WardenError("hook input must be an object")
    if platform == "codex":
        event = data.get("hook_event_name")
        if event == "PreToolUse": return "pretool", {"tool": data.get("tool_name"), "input": data.get("tool_input")}
        if event in {"Stop", "SubagentStop"}:
            if "stop_hook_active" in data and not isinstance(data["stop_hook_active"], bool): raise WardenError("stop_hook_active must be boolean")
            inp = data.get("input", {})
            if not isinstance(inp, dict): inp = {}
            agent_id = data.get("agent_id", inp.get("agent_id"))
            if agent_id is not None and not isinstance(agent_id, str): raise WardenError("agent_id must be a string")
            if event == "SubagentStop": return "subagent_stop", {"agent_id": agent_id}
            return "completion_request", {"stop_hook_active": data.get("stop_hook_active", False)}
        if event == "UserPromptSubmit": return "prompt", {"prompt": data.get("prompt")}
    elif platform == "claude":
        event = data.get("hook_event_name")
        if event == "PreToolUse": return "pretool", {"tool": data.get("tool_name"), "input": data.get("tool_input")}
        if event in {"Stop", "SubagentStop"}:
            if "stop_hook_active" in data and not isinstance(data["stop_hook_active"], bool): raise WardenError("stop_hook_active must be boolean")
            agent_id = data.get("agent_id")
            if agent_id is not None and not isinstance(agent_id, str): raise WardenError("agent_id must be a string")
            if event == "SubagentStop": return "subagent_stop", {"agent_id": agent_id}
            return "completion_request", {"stop_hook_active": data.get("stop_hook_active", False)}
        if event == "UserPromptSubmit": return "prompt", {"prompt": data.get("prompt")}
    elif platform == "gemini":
        event = data.get("hook_event_name")
        if event == "BeforeTool": return "pretool", {"tool": data.get("tool_name"), "input": data.get("tool_input")}
        if event == "AfterAgent":
            if "stop_hook_active" in data and not isinstance(data["stop_hook_active"], bool): raise WardenError("stop_hook_active must be boolean")
            return "completion_request", {"stop_hook_active": data.get("stop_hook_active", False)}
        if event == "BeforeAgent": return "prompt", {"prompt": data.get("prompt")}
    raise WardenError("unsupported hook event")


def _pretool(task: dict[str, Any], tool: Any, inp: Any) -> dict[str, Any]:
    if not isinstance(tool, str) or not isinstance(inp, dict):
        return {"decision": "deny", "reason": "malformed or unknown tool request"}
    if tool in WRITE_TOOLS and task["state"] != "ACTIVE":
        return {"decision": "deny", "reason": f"task state {task['state']} does not allow writes"}
    if tool not in READ_TOOLS | WRITE_TOOLS:
        return {"decision": "deny", "reason": "unknown or opaque tool; controller cannot prove scope"}
    paths = []
    for k in ("file_path", "path", "target_file"):
        if k in inp: paths.append(inp[k])
    if tool == "apply_patch":
        patch = inp.get("patch", inp.get("input", inp.get("command")))
        if not isinstance(patch, str): return {"decision": "deny", "reason": "patch content not inspectable"}
        # Accept unified headers and Codex apply_patch directives; reject opaque commands.
        import re
        if "*** Begin Patch" in patch:
            lines = patch.splitlines()
            if not lines or lines[0] != "*** Begin Patch" or lines[-1] != "*** End Patch":
                return {"decision": "deny", "reason": "malformed apply_patch envelope"}
            allowed_meta = {"*** Begin Patch", "*** End Patch", "*** End of File"}
            for line in lines[1:-1]:
                if line.startswith("*** Add File: ") or line.startswith("*** Update File: ") or line.startswith("*** Delete File: ") or line.startswith("*** Move to: "):
                    path = line.split(": ", 1)[1]
                    if not path or path != path.strip() or any(ord(c) < 32 for c in path):
                        return {"decision": "deny", "reason": "ambiguous apply_patch path"}
                    paths.append(path)
                elif line.startswith("--- ") or line.startswith("+++ "):
                    return {"decision": "deny", "reason": "unified diff paths are ambiguous; use explicit apply_patch directives"}
                elif line.startswith("***") and line not in allowed_meta and not line.startswith("*** Update File: "):
                    return {"decision": "deny", "reason": "unsupported apply_patch directive"}
            if not paths: return {"decision": "deny", "reason": "apply_patch contains no explicit file directives"}
        else:
            return {"decision": "deny", "reason": "opaque patch format"}
    # Read tools may identify one or more paths using their native argument names.
    if tool in READ_TOOLS:
        for k in ("file_path", "path", "directory", "dir_path", "pattern"):
            v = inp.get(k)
            if isinstance(v, str) and v and not any(ch in v for ch in "*?["):
                paths.append(v)
        if tool in {"Glob", "Grep"} and not paths:
            paths = ["."]
    if not paths or any(not isinstance(p, str) for p in paths):
        return {"decision": "deny", "reason": "file target is not explicit"}
    scope = task["requirements"]["scope"]
    import pathlib
    for p in paths:
        candidate = pathlib.Path(p)
        if ".." in candidate.parts:
            return {"decision": "deny", "reason": "unsafe target path"}
        # Resolve existing ancestors as well: a lexically in-scope symlink may point out.
        base = pathlib.Path(task["workspace"]).resolve()
        target = candidate if candidate.is_absolute() else base / candidate
        try:
            lexical_rel = target.relative_to(base)
        except ValueError:
            return {"decision": "deny", "reason": "target outside workspace"}
        probe = target
        absent_parts = []
        while not probe.exists() and not probe.is_symlink() and probe != base:
            absent_parts.append(probe.name)
            probe = probe.parent
        real_target = probe.resolve()
        for part in reversed(absent_parts): real_target /= part
        if not real_target.is_relative_to(base):
            return {"decision": "deny", "reason": "target resolves outside workspace"}
        inside_scope = False
        for s in scope:
            scope_root = (base / s).resolve()
            try:
                lexical_rel.relative_to(pathlib.Path(s))
                lexical_inside = True
            except ValueError:
                lexical_inside = False
            if lexical_inside and (real_target == scope_root or real_target.is_relative_to(scope_root)):
                inside_scope = True
                break
        if not inside_scope:
            return {"decision": "deny", "reason": "target outside authorized scope"}
    return {"decision": "allow", "reason": "explicit target is within authorized scope"}


def translate(platform: str, controller: Controller, task_id: str, role: str, token: str, data: Any,
              *, raise_errors: bool = False) -> dict[str, Any]:
    """Return valid native hook JSON. Errors are explicit deny/block responses."""
    try:
        event, payload = normalize(platform, data)
        if event == "pretool":
            st = controller.status(task_id, token, role)
            result = _pretool(st, payload["tool"], payload["input"])
        elif event == "prompt":
            controller.status(task_id, token, role)
            result = {"decision": "allow", "reason": "prompt recorded for controller visibility only"}
        elif event == "subagent_stop":
            # A child's stop is local to that child and never completes the parent task.
            controller.status(task_id, token, role)
            result = {"decision": "SUBAGENT_STOP", "reason": "subagent stopped; parent task remains active"}
        else:
            current = controller.status(task_id, token, role)
            out = controller.decide(task_id, role, token, "completion_request", payload, current["version"])
            result = {"decision": out["decision"], "reason": out["reason"]}
        return native(platform, event, result)
    except Exception:
        if raise_errors:
            raise
        event_name = data.get("hook_event_name") if isinstance(data, dict) else None
        return hook_error_response(platform, event_name, task_id, controller.db, controller.workspace)


def native(platform: str, event: str, result: dict[str, str]) -> dict[str, Any]:
    decision = result.get("decision", "BLOCKED")
    reason = result.get("reason", "TaskWarden could not verify completion; inspect the controller and continue diagnosis.")
    # Only reviewed acceptance or an intentional owner stop may end an agent turn.
    # BLOCKED and INVESTIGATION remain incomplete states, so a Stop callback must
    # send an actionable continuation reason to the native host.
    block_stop = decision not in {"ACCEPT", "PAUSED", "CANCELLED", "SUBAGENT_STOP"}
    if platform == "codex":
        if event == "prompt": return {}
        if event == "pretool":
            return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow" if decision == "allow" else "deny", "permissionDecisionReason": reason}}
        if event == "completion_request" and block_stop: return {"decision": "block", "reason": reason}
        if event == "subagent_stop" and decision == "SUBAGENT_STOP": return {"continue": False, "stopReason": reason}
        return {"continue": False, "stopReason": reason}
    if platform == "claude":
        if event == "prompt": return {}
        if event == "pretool":
            return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow" if decision == "allow" else "deny", "permissionDecisionReason": reason}}
        if event == "completion_request" and block_stop: return {"decision": "block", "reason": reason}
        if event == "subagent_stop" and decision == "SUBAGENT_STOP": return {"continue": False, "stopReason": reason}
        return {"continue": False, "stopReason": reason}
    if platform == "gemini":
        if event == "prompt": return {"decision": "allow", "reason": reason}
        if event == "pretool": return {"decision": decision, "reason": reason}
        if event == "completion_request" and block_stop: return {"decision": "deny", "reason": reason}
        if event == "subagent_stop" and decision == "SUBAGENT_STOP": return {"continue": False, "stopReason": reason}
        return {"continue": False, "stopReason": reason}
    raise WardenError("unsupported platform")
