"""Opt-in defense-in-depth for a TaskWarden supervisor process.

These checks are not an OS security boundary. A same-account process may be able
to change the process DACL, and an administrator can bypass it. Use a separate
Windows principal/service for durable isolation.
"""
from __future__ import annotations

import ctypes
import os
import re
from pathlib import Path
from typing import Any
from .adapters import native


_LIFECYCLE = re.compile(
    r"(?i)(?:\bStop-Process\b|\btaskkill(?:\.exe)?\b|\bTerminateProcess\b|"
    r"\bStop-Service\b|\bRestart-Service\b|\bSet-Service\b|\bRemove-Service\b|"
    r"\b(?:Stop|Restart)-Computer\b|"
    r"\b(?:kill|spps|pkill|killall)(?:\.exe)?(?:\s+|\s*\()|"
    r"\bInvoke-(?:Cim|Wmi)Method\b[\s\S]*?-(?:MethodName|Name)\s+['\"]?Terminate\b|"
    r"\bwmic(?:\.exe)?\b[\s\S]*?\bcall\s+terminate\b|"
    r"\bsc(?:\.exe)?\s+(?:stop|delete|config|failure)\b|"
    r"\bschtasks(?:\.exe)?\s+/(?:end|delete|change)\b|"
    r"\b(?:os\.)?kill\s*\(|\bkill(?:\.exe)?\s+-|\bTerminate\s*\()"
)
_PATH_FIELDS = {"file_path", "path", "target_file", "directory", "dir_path", "source", "destination", "from", "to"}
_SHELL_TOOLS = {"bash", "powershell", "pwsh", "shell", "exec", "exec_command", "functions.exec",
                "functions.exec_command", "terminal"}
_CODE_TOOLS = {"functions.exec", "node_repl.js", "mcp__node_repl.js"}
_MUTATING_TOOLS = {"write", "edit", "multiedit", "notebookedit", "apply_patch", "delete", "move", "rename", "copy"}
_HOOK_CONFIG_PARTS = {(".codex", "hooks.json"), (".codex", "config.toml"),
                      (".claude", "settings.json"), (".claude", "settings.local.json"),
                      (".gemini", "settings.json"), (".gemini", "settings.local.json")}
_PATCH_PATH = re.compile(r"(?m)^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$|^\*\*\* Move to: (.+?)\s*$")
_QUOTED_OR_TOKEN = re.compile(r'''(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s"'<>|,;]+))''')
_SHELL_MUTATION = re.compile(
    r"(?i)(?:\b(?:Set|Add|Clear|Remove|Move|Rename|Copy|New)-(?:Content|Item|Acl|Service)\b|"
    r"\b(?:rm|rmdir|del|erase|mkdir|chmod|chown|icacls)(?:\.exe)?\b|"
    r"\b(?:os\.(?:remove|unlink|rename)|shutil\.(?:rmtree|move|copy))\s*\(|(?:^|\s)(?:>|>>))"
)


def _deny(platform: str, reason: str) -> dict[str, Any]:
    return native(platform, "pretool", {"decision": "deny", "reason": reason})


def validate_control_plane_paths(workspace: str | Path, runtime_root: str | Path,
                                 state_root: str | Path) -> tuple[Path, Path]:
    workspace_path = Path(workspace)
    runtime, state = Path(runtime_root), Path(state_root)
    if not workspace_path.is_absolute() or not runtime.is_absolute() or not state.is_absolute():
        raise ValueError("workspace and protected control-plane paths must be absolute")
    workspace_path, runtime, state = (p.resolve(strict=False) for p in (workspace_path, runtime, state))
    if runtime == state or _is_under(runtime, state) or _is_under(state, runtime):
        raise ValueError("control-plane runtime and state roots must be disjoint")
    if any(_is_under(path, workspace_path) or _is_under(workspace_path, path) for path in (runtime, state)):
        raise ValueError("protected control-plane roots must be disjoint from the executor workspace")
    return runtime, state


def _walk_strings(value: Any, key: str = ""):
    if isinstance(value, dict):
        for child_key, child in value.items():
            yield from _walk_strings(child, child_key.casefold())
    elif isinstance(value, list):
        for child in value:
            yield from _walk_strings(child, key)
    elif isinstance(value, str):
        yield key, value


def _is_under(path: Path, root: Path) -> bool:
    try:
        target = os.path.normcase(str(path.resolve(strict=False)))
        base = os.path.normcase(str(root.resolve(strict=False)))
        return os.path.commonpath((target, base)) == base
    except (OSError, ValueError):
        return False


def _resolve_request_path(raw: str, workspace: Path) -> Path | None:
    value = raw.strip().strip('"').strip("'")
    if not value or "\x00" in value:
        return None
    try:
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = workspace / candidate
        return candidate.resolve(strict=False)
    except (OSError, ValueError, RuntimeError):
        return None


def _is_hook_config(path: Path, workspace: Path) -> bool:
    try:
        rel = path.resolve(strict=False).relative_to(workspace.resolve(strict=False))
    except (OSError, ValueError):
        return False
    parts = tuple(part.casefold() for part in rel.parts)
    return len(parts) >= 2 and parts[-2:] in _HOOK_CONFIG_PARTS


def _is_hook_config_area(path: Path, workspace: Path) -> bool:
    try:
        rel = path.resolve(strict=False).relative_to(workspace.resolve(strict=False))
    except (OSError, ValueError):
        return False
    parts = tuple(part.casefold() for part in rel.parts)
    return any(len(parts) >= 1 and parts[0] == folder
               for folder in (".codex", ".claude", ".gemini"))


def _request_cwd(tool_input: dict[str, Any], workspace: Path) -> Path | None:
    values = [value for key, value in _walk_strings(tool_input) if key in {"cwd", "workdir"}]
    # Non-string cwd/workdir fields are malformed even though _walk_strings skips them.
    def has_malformed(value: Any) -> bool:
        if isinstance(value, dict):
            return any((key.casefold() in {"cwd", "workdir"} and not isinstance(child, str))
                       or has_malformed(child) for key, child in value.items())
        if isinstance(value, list):
            return any(has_malformed(child) for child in value)
        return False
    if has_malformed(tool_input):
        return None
    if not values:
        return workspace
    if len(values) > 1 and values[0] != values[1]:
        return None
    value = values[0]
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        return None
    if not Path(value).is_absolute():
        return None
    resolved = _resolve_request_path(value, workspace)
    if resolved is None:
        return None
    return resolved


class _InspectionLimitError(ValueError):
    """The request cannot be completely inspected within the configured bound."""


def _bounded_path_tokens(raw: str):
    """Extract ordinary quoted/bare path tokens, then inspect one nested quote layer."""
    if len(raw) > 8192:
        raise _InspectionLimitError("path text inspection limit exceeded")
    pending = [raw]
    for depth in range(2):
        next_pending = []
        seen = 0
        for text in pending:
            for match in _QUOTED_OR_TOKEN.finditer(text):
                seen += 1
                if seen > 128:
                    raise _InspectionLimitError("path token inspection limit exceeded")
                token = next((part for part in match.groups() if part is not None), "")
                if not token:
                    continue
                yield token
                if depth == 0 and ("'" in token or '"' in token):
                    next_pending.append(token)
        pending = next_pending
        if not pending:
            return


def _tool_payload_decision(platform: str, data: dict[str, Any], workspace: Path,
                           protected_roots: tuple[Path, ...]) -> dict[str, Any] | None:
    tool = data.get("tool_name")
    tool_input = data.get("tool_input")
    if not isinstance(tool, str) or not tool.strip() or not isinstance(tool_input, dict):
        return _deny(platform, "TaskWarden could not inspect the tool name or payload; control-plane guard fails closed.")
    tool_key = tool.casefold()
    cwd = _request_cwd(tool_input, workspace)
    if cwd is None:
        return _deny(platform, "TaskWarden could not resolve the tool's working directory; control-plane guard fails closed.")
    strings = list(_walk_strings(tool_input))
    if any(len(value) > 8192 for key, value in strings
           if key in {"command", "cmd", "code", "source", "script", "patch"}):
        return _deny(platform, "TaskWarden could not inspect an oversized tool payload; control-plane guard fails closed.")
    if any(_LIFECYCLE.search(value) for key, value in strings
           if key in {"command", "cmd", "code", "source", "script"}):
        return _deny(platform, "Executor tools cannot stop, kill, or reconfigure the TaskWarden supervisor; report the issue to its owner.")

    path_values: list[str] = []
    for key, value in strings:
        if key in _PATH_FIELDS or key in {"command", "cmd", "code", "source", "script", "patch", "input"}:
            if key == "patch":
                path_values.extend(part for match in _PATCH_PATH.findall(value) for part in match if part)
            else:
                path_values.append(value)
    # Tool wrappers such as functions.exec carry source rather than a file path.
    # Missing/ill-typed source is opaque and therefore cannot pass this guard.
    if tool_key in _CODE_TOOLS:
        sources = [value for key, value in strings if key in {"code", "source", "script"}]
        if not sources or any(not source.strip() for source in sources):
            return _deny(platform, "TaskWarden cannot inspect the executor code payload; control-plane guard fails closed.")
    if tool_key in (_SHELL_TOOLS - _CODE_TOOLS) and not any(key in {"command", "cmd"} for key, _ in strings):
        return _deny(platform, "TaskWarden cannot inspect the shell command payload; control-plane guard fails closed.")

    mutating = (tool_key in _MUTATING_TOOLS or any(
        key in {"command", "cmd", "code", "source", "script"} and _SHELL_MUTATION.search(value)
        for key, value in strings))

    for raw in path_values:
        candidate = _resolve_request_path(raw, cwd)
        if candidate is not None and (any(_is_under(candidate, root) for root in protected_roots)
                or _is_hook_config(candidate, workspace)
                or (mutating and (any(_is_under(root, candidate) for root in protected_roots)
                                  or _is_hook_config_area(candidate, workspace)))):
            return _deny(platform, "TaskWarden runtime, state, and project hook configuration are owner-controlled.")
        # Also normalize path-like tokens embedded in commands or source. This
        # catches relative traversal and dot segments without parsing execution.
        for part in _bounded_path_tokens(raw):
            if ("/" not in part and "\\" not in part and not re.match(r"^[A-Za-z]:", part)
                    and not (mutating and not part.startswith("-") and part not in {"{}", ""})):
                continue
            embedded = _resolve_request_path(part, cwd)
            if embedded is not None and (any(_is_under(embedded, root) for root in protected_roots)
                    or _is_hook_config(embedded, workspace)
                    or (mutating and (any(_is_under(root, embedded) for root in protected_roots)
                                      or _is_hook_config_area(embedded, workspace)))):
                return _deny(platform, "TaskWarden runtime, state, and project hook configuration are owner-controlled.")
    return None


def guard_pretool(platform: str, data: Any, *, workspace: str | Path,
                  runtime_root: str | Path, state_root: str | Path) -> dict[str, Any]:
    """Deny explicit supervisor lifecycle or protected-path requests; otherwise abstain.

    An empty response leaves the host's ordinary tool permission policy in force.
    """
    if not isinstance(data, dict):
        return _deny(platform, "TaskWarden could not inspect this tool request; controller remains protected.")
    event = data.get("hook_event_name")
    if event not in {"PreToolUse", "BeforeTool"}:
        return _deny(platform, "TaskWarden control-plane guard received an unsupported event.")
    tool_input = data.get("tool_input")
    workspace_path = Path(workspace).resolve(strict=False)
    protected = (Path(runtime_root).resolve(strict=False), Path(state_root).resolve(strict=False),
                 Path(__file__).resolve(strict=False).parent)
    try:
        decision = _tool_payload_decision(platform, data, workspace_path, protected)
    except _InspectionLimitError:
        return _deny(platform, "TaskWarden could not completely inspect this request within its token limit; control-plane guard fails closed.")
    return decision if decision is not None else {}


def protect_current_process_from_termination(executor_sid: str) -> None:
    """Add a Windows DACL deny ACE for PROCESS_TERMINATE to an explicit SID.

    This is defense-in-depth against ordinary termination attempts, not isolation
    from the same-account owner, a process that already has a terminate handle,
    or an administrator.
    """
    if os.name != "nt":
        raise OSError("process DACL protection is available only on Windows")
    if not isinstance(executor_sid, str) or not re.fullmatch(r"S-\d(?:-\d+)+", executor_sid):
        raise ValueError("executor SID must be an explicit canonical SID")

    class TRUSTEE(ctypes.Structure):
        _fields_ = [("pMultipleTrustee", ctypes.c_void_p), ("MultipleTrusteeOperation", ctypes.c_int),
                    ("TrusteeForm", ctypes.c_int), ("TrusteeType", ctypes.c_int),
                    ("ptstrName", ctypes.c_void_p)]

    class EXPLICIT_ACCESS(ctypes.Structure):
        _fields_ = [("grfAccessPermissions", ctypes.c_uint), ("grfAccessMode", ctypes.c_int),
                    ("grfInheritance", ctypes.c_uint), ("Trustee", TRUSTEE)]

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    advapi.ConvertStringSidToSidW.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_void_p)]
    advapi.ConvertStringSidToSidW.restype = ctypes.c_int
    sid_ptr = ctypes.c_void_p()
    old_dacl, new_dacl, security_descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
    if not advapi.ConvertStringSidToSidW(executor_sid, ctypes.byref(sid_ptr)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        get_info = advapi.GetSecurityInfo
        get_info.restype = ctypes.c_ulong
        get_info.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p,
                             ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
                             ctypes.POINTER(ctypes.c_void_p)]
        error = get_info(kernel.GetCurrentProcess(), 6, 4, None, None, ctypes.byref(old_dacl), None,
                         ctypes.byref(security_descriptor))
        if error:
            raise ctypes.WinError(error)
        entry = EXPLICIT_ACCESS(1, 3, 0, TRUSTEE(None, 0, 0, 1, sid_ptr))
        set_entries = advapi.SetEntriesInAclW
        set_entries.restype = ctypes.c_ulong
        set_entries.argtypes = [ctypes.c_ulong, ctypes.POINTER(EXPLICIT_ACCESS), ctypes.c_void_p,
                                ctypes.POINTER(ctypes.c_void_p)]
        error = set_entries(1, ctypes.byref(entry), old_dacl, ctypes.byref(new_dacl))
        if error:
            raise ctypes.WinError(error)
        set_info = advapi.SetSecurityInfo
        set_info.restype = ctypes.c_ulong
        set_info.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p,
                             ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        error = set_info(kernel.GetCurrentProcess(), 6, 4, None, None, new_dacl, None)
        if error:
            raise ctypes.WinError(error)
    finally:
        if new_dacl:
            kernel.LocalFree(new_dacl)
        if security_descriptor:
            kernel.LocalFree(security_descriptor)
        if sid_ptr:
            kernel.LocalFree(sid_ptr)
