#!/usr/bin/env python3
"""Zero-dependency local MCP server for TaleWisp."""

from __future__ import annotations

import hashlib
import importlib.util
import difflib
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


SERVER_NAME = "talewisp"
SERVER_VERSION = "0.6.2"
DEFAULT_PROTOCOL = "2024-11-05"
TEXT_EXTENSIONS = {".md", ".txt"}
EXCLUDED_DIRS = {
    ".git",
    ".obsidian",
    ".trash",
    ".talewisp",
    ".agents",
    "node_modules",
    "plugins",
    "__pycache__",
}
WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]")
MAX_SCENE_CONTEXT_LINKS = 50
PROFILE_SCOPE_FIELDS = ("scope", "project", "project_id", "series", "series_id", "book", "book_id")


class TaleWispError(Exception):
    pass


@dataclass
class VaultState:
    root: Path


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TaleWispError(f"Cannot read JSON file {path}: {exc}") from exc


def discover_vault() -> Path:
    env_root = os.environ.get("TALEWISP_VAULT")
    if env_root:
        root = Path(env_root).expanduser().resolve()
        if root.is_dir():
            return root

    current = Path.cwd().resolve()
    for candidate in (current, *current.parents):
        config_path = candidate / ".talewisp" / "config.json"
        if config_path.is_file():
            config = load_json(config_path)
            configured = config.get("vaultPath", ".")
            root = (candidate / configured).resolve()
            if root.is_dir():
                return root
    return current


STATE = VaultState(discover_vault())
PROJECT_ROOT = Path(os.environ.get("TALEWISP_PROJECT_ROOT") or Path.cwd()).expanduser().resolve()


def model_selection_module():
    name = "talewisp_model_selection"
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name("model_selection.py"))
        if spec is None or spec.loader is None:
            raise TaleWispError("Model selection module is unavailable")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return module


def model_selection(args: dict[str, Any]) -> dict[str, Any]:
    module = model_selection_module()
    requested_root = Path(args.get("project_root") or PROJECT_ROOT).expanduser()
    if not requested_root.is_absolute():
        requested_root = PROJECT_ROOT / requested_root
    root = requested_root.resolve()
    if not root.is_relative_to(PROJECT_ROOT):
        raise TaleWispError("Model selection project root escapes the startup project")
    try:
        return module.resolve_selection(root, args.get("model"), args.get("effort"),
                                        args.get("choice"), args.get("available_models"))
    except (module.ModelSelectionError, OSError) as exc:
        raise TaleWispError(str(exc)) from exc


def project_model_status() -> dict[str, Any]:
    module = model_selection_module()
    try:
        return module.model_status(PROJECT_ROOT)
    except module.ModelSelectionError as exc:
        raise TaleWispError(str(exc)) from exc


def ensure_within(root: Path, candidate: Path) -> Path:
    resolved_root = root.resolve()
    resolved = candidate.resolve()
    try:
        resolved.relative_to(resolved_root)
    except ValueError as exc:
        raise TaleWispError("Path escapes the active TaleWisp vault") from exc
    return resolved


def resolve_user_path(relative_path: str, *, must_exist: bool = True) -> Path:
    if not relative_path or Path(relative_path).is_absolute():
        raise TaleWispError("Use a non-empty path relative to the active vault")
    path = ensure_within(STATE.root, STATE.root / relative_path)
    if must_exist and not path.is_file():
        raise TaleWispError(f"Story file not found: {relative_path}")
    return path


def relative(path: Path) -> str:
    return path.resolve().relative_to(STATE.root.resolve()).as_posix()


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as exc:
        raise TaleWispError(f"File is not UTF-8 text: {relative(path)}") from exc


def iter_story_files() -> Iterable[Path]:
    if not STATE.root.is_dir():
        return
    for directory, dirs, files in os.walk(STATE.root):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDED_DIRS and not d.startswith("."))
        base = Path(directory)
        for name in sorted(files):
            path = base / name
            if path.suffix.lower() in TEXT_EXTENSIONS:
                yield path


def parse_scalar(value: str) -> Any:
    value = value.strip()
    if not value:
        return ""
    if value.startswith("[") and value.endswith("]"):
        try:
            return json.loads(value.replace("'", '"'))
        except json.JSONDecodeError:
            return [item.strip().strip("\"'") for item in value[1:-1].split(",") if item.strip()]
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    return value.strip("\"'")


def parse_frontmatter(text: str) -> dict[str, Any]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    result: dict[str, Any] = {}
    current_list: str | None = None
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if current_list and re.match(r"^\s+-\s+", line):
            result[current_list].append(parse_scalar(re.sub(r"^\s+-\s+", "", line)))
            continue
        current_list = None
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if not match:
            continue
        key, value = match.groups()
        if value == "":
            result[key] = []
            current_list = key
        else:
            result[key] = parse_scalar(value)
    return result


def file_record(path: Path, include_excerpt: bool = False) -> dict[str, Any]:
    text = read_text(path)
    frontmatter = parse_frontmatter(text)
    record: dict[str, Any] = {
        "path": relative(path),
        "title": frontmatter.get("title") or path.stem,
        "type": frontmatter.get("type") or "note",
        "canon_status": frontmatter.get("canon_status"),
        "characters": frontmatter.get("characters", []),
        "story_time": frontmatter.get("story_time"),
        "characters_count": len(text),
        "sha256": sha256_text(text),
    }
    if include_excerpt:
        body = re.sub(r"^---\s*.*?\s*---\s*", "", text, count=1, flags=re.DOTALL)
        record["excerpt"] = body.strip()[:500]
    return record


def resolve_wikilink_details(target: str, source: Path) -> dict[str, Any]:
    """Resolve one wikilink without hiding a name collision in the vault."""
    cleaned = target.strip().replace("\\", "/")
    candidates = []
    direct = source.parent / cleaned
    candidates.extend([direct, direct.with_suffix(".md")])
    vault_direct = STATE.root / cleaned
    candidates.extend([vault_direct, vault_direct.with_suffix(".md")])
    for candidate in candidates:
        try:
            resolved = ensure_within(STATE.root, candidate)
        except TaleWispError:
            continue
        if resolved.is_file():
            return {"status": "resolved", "path": resolved, "candidates": []}
    wanted = Path(cleaned).stem.casefold()
    matches = [path for path in iter_story_files() if path.stem.casefold() == wanted]
    if len(matches) == 1:
        return {"status": "resolved", "path": matches[0], "candidates": []}
    if matches:
        return {
            "status": "ambiguous",
            "path": None,
            "candidates": [relative(path) for path in matches],
        }
    return {"status": "missing", "path": None, "candidates": []}


def resolve_wikilink(target: str, source: Path) -> Path | None:
    """Backward-compatible path-only wikilink resolver."""
    details = resolve_wikilink_details(target, source)
    return details["path"] if details["status"] == "resolved" else None


def is_style_profile(metadata: dict[str, Any]) -> bool:
    return str(metadata.get("type") or "").casefold() == "style-profile"


def is_style_index(metadata: dict[str, Any]) -> bool:
    kind = str(metadata.get("type") or "").casefold()
    profile_kind = str(metadata.get("profile_kind") or "").casefold()
    return kind == "style-index" or (kind == "style-profile" and profile_kind == "index")


def select_vault(args: dict[str, Any]) -> dict[str, Any]:
    raw = args.get("path", "")
    root = Path(raw).expanduser().resolve()
    if not root.is_dir():
        raise TaleWispError(f"Vault directory does not exist: {raw}")
    STATE.root = root
    return project_status({})


def project_status(args: dict[str, Any]) -> dict[str, Any]:
    files = list(iter_story_files())
    counts: dict[str, int] = {}
    confirmed = 0
    for path in files:
        meta = parse_frontmatter(read_text(path))
        kind = str(meta.get("type") or "note")
        counts[kind] = counts.get(kind, 0) + 1
        if meta.get("canon_status") == "confirmed":
            confirmed += 1
    pending = STATE.root / ".talewisp" / "proposals" / "pending"
    return {
        "vault": str(STATE.root),
        "files": len(files),
        "types": dict(sorted(counts.items())),
        "confirmed_files": confirmed,
        "pending_proposals": len(list(pending.glob("*.json"))) if pending.is_dir() else 0,
        "model_selection": project_model_status(),
    }


def onboarding_status(args: dict[str, Any]) -> dict[str, Any]:
    records = []
    meaningful_samples = []
    for path in iter_story_files():
        text = read_text(path)
        metadata = parse_frontmatter(text)
        body = re.sub(r"^---\s*.*?\s*---\s*", "", text, count=1, flags=re.DOTALL).strip()
        record = {
            "path": relative(path),
            "type": metadata.get("type") or "note",
            "profile_kind": metadata.get("profile_kind"),
            "setup_status": metadata.get("setup_status"),
            "canon_status": metadata.get("canon_status"),
            "scope": {key: metadata[key] for key in PROFILE_SCOPE_FIELDS if key in metadata},
        }
        records.append(record)
        if record["type"] == "scene" and len(body) >= 500 and "начните писать сцену здесь" not in body.casefold():
            meaningful_samples.append(record["path"])

    def setup(kind: str, profile_kind: str | None = None) -> dict[str, Any]:
        matches = [
            item for item in records
            if item["type"] == kind and (profile_kind is None or item["profile_kind"] == profile_kind)
        ]
        if not matches:
            return {"state": "missing", "paths": [], "profiles": [], "ambiguous": False}
        states = [str(item["setup_status"] or "draft") for item in matches]
        if len(matches) > 1:
            state = "ambiguous"
        elif "confirmed" in states:
            state = "confirmed"
        elif any(value not in {"", "empty"} for value in states):
            state = "draft"
        else:
            state = "empty"
        return {
            "state": state,
            "paths": [item["path"] for item in matches],
            "profiles": matches,
            "ambiguous": len(matches) > 1,
        }

    author = setup("author-profile")
    series_brief = setup("series-brief")
    book_brief = setup("book-brief")
    style = {
        "author_voice": setup("style-profile", "author-voice"),
        "genre_contract": setup("style-profile", "genre-contract"),
        "narrative_mode": setup("style-profile", "narrative-mode"),
    }
    routes = []
    if author["state"] != "confirmed":
        routes.append({
            "code": "author_introduction",
            "reason": "No single confirmed author profile is available.",
        })
    if meaningful_samples and style["author_voice"]["state"] != "confirmed":
        routes.append({
            "code": "style_analysis",
            "reason": "Representative prose exists, but no single confirmed authorial profile is available.",
        })
    if series_brief["state"] != "confirmed":
        routes.append({
            "code": "series_design",
            "reason": "No single confirmed series brief is available.",
        })
    if book_brief["state"] != "confirmed":
        routes.append({
            "code": "book_design",
            "reason": "No single confirmed book brief is available; select or confirm one.",
        })
    if not meaningful_samples:
        routes.append({
            "code": "request_style_sample",
            "reason": "No representative scene of at least 500 characters was found.",
        })

    return {
        "vault": str(STATE.root),
        "first_run": author["state"] != "confirmed",
        "author_profile": author,
        "style_profiles": style,
        "series_brief": series_brief,
        "book_brief": book_brief,
        "active_book": None,
        "meaningful_style_samples": meaningful_samples,
        "recommended_routes": routes,
        "model_selection": project_model_status(),
    }


def list_files(args: dict[str, Any]) -> dict[str, Any]:
    requested_type = str(args.get("type") or "").casefold()
    folder = str(args.get("folder") or "").replace("\\", "/").strip("/")
    limit = max(1, min(int(args.get("limit", 100)), 500))
    records = []
    for path in iter_story_files():
        rel = relative(path)
        if folder and not rel.casefold().startswith(folder.casefold() + "/"):
            continue
        record = file_record(path)
        if requested_type and str(record["type"]).casefold() != requested_type:
            continue
        records.append(record)
        if len(records) >= limit:
            break
    return {"vault": str(STATE.root), "items": records, "returned": len(records)}


def read_file(args: dict[str, Any]) -> dict[str, Any]:
    path = resolve_user_path(str(args.get("path") or ""))
    max_chars = max(1000, min(int(args.get("max_chars", 40000)), 200000))
    text = read_text(path)
    return {
        "path": relative(path),
        "sha256": sha256_text(text),
        "truncated": len(text) > max_chars,
        "content": text[:max_chars],
    }


def search_story(args: dict[str, Any]) -> dict[str, Any]:
    query = str(args.get("query") or "").strip()
    if not query:
        raise TaleWispError("Search query must not be empty")
    limit = max(1, min(int(args.get("limit", 20)), 100))
    requested_type = str(args.get("type") or "").casefold()
    needle = query.casefold()
    results = []
    for path in iter_story_files():
        text = read_text(path)
        meta = parse_frontmatter(text)
        if requested_type and str(meta.get("type") or "note").casefold() != requested_type:
            continue
        folded = text.casefold()
        start = folded.find(needle)
        if start < 0:
            continue
        left = max(0, start - 180)
        right = min(len(text), start + len(query) + 260)
        results.append({
            "path": relative(path),
            "type": meta.get("type") or "note",
            "title": meta.get("title") or path.stem,
            "snippet": text[left:right].replace("\n", " ").strip(),
        })
        if len(results) >= limit:
            break
    return {"query": query, "results": results, "returned": len(results)}


def compare_style_edit(args: dict[str, Any]) -> dict[str, Any]:
    ai_text = str(args.get("ai_text") or "")
    author_text = str(args.get("author_text") or "")
    if not ai_text.strip() or not author_text.strip():
        raise TaleWispError("ai_text and author_text must not be empty")

    token_pattern = re.compile(r"\w+|[^\w\s]", flags=re.UNICODE)
    ai_tokens = token_pattern.findall(ai_text)
    author_tokens = token_pattern.findall(author_text)
    matcher = difflib.SequenceMatcher(a=ai_tokens, b=author_tokens, autojunk=False)
    equal = inserted = deleted = replaced_ai = replaced_author = 0
    segments = []
    for tag, a1, a2, b1, b2 in matcher.get_opcodes():
        old = ai_tokens[a1:a2]
        new = author_tokens[b1:b2]
        if tag == "equal":
            equal += len(old)
            continue
        if tag == "insert":
            inserted += len(new)
        elif tag == "delete":
            deleted += len(old)
        elif tag == "replace":
            replaced_ai += len(old)
            replaced_author += len(new)
        if len(segments) < 30:
            segments.append({
                "operation": tag,
                "ai": " ".join(old),
                "author": " ".join(new),
            })

    edit_units = inserted + deleted + max(replaced_ai, replaced_author)
    denominator = max(len(ai_tokens), len(author_tokens), 1)
    change_ratio = min(1.0, edit_units / denominator)
    if change_ratio <= 0.10:
        change_band = "minimal"
    elif change_ratio <= 0.25:
        change_band = "moderate"
    else:
        change_band = "substantial"

    return {
        "ai_tokens": len(ai_tokens),
        "author_tokens": len(author_tokens),
        "unchanged_tokens": equal,
        "inserted_tokens": inserted,
        "deleted_tokens": deleted,
        "replaced_ai_tokens": replaced_ai,
        "replaced_author_tokens": replaced_author,
        "change_ratio": round(change_ratio, 4),
        "change_percent": round(change_ratio * 100, 1),
        "change_band": change_band,
        "sequence_similarity": round(matcher.ratio(), 4),
        "diff_segments": segments,
        "diff_truncated": len([opcode for opcode in matcher.get_opcodes() if opcode[0] != "equal"]) > len(segments),
    }


def scene_context(args: dict[str, Any]) -> dict[str, Any]:
    source = resolve_user_path(str(args.get("path") or ""))
    budget = max(4000, min(int(args.get("max_chars", 60000)), 160000))
    max_link_depth = max(1, min(int(args.get("max_link_depth", 2)), 2))
    scene = read_text(source)
    links: list[dict[str, Any]] = []
    unresolved_details: list[dict[str, Any]] = []
    seen = {source.resolve()}
    queue = [(source, target, 1) for target in WIKILINK_RE.findall(scene)]

    while queue and len(links) < MAX_SCENE_CONTEXT_LINKS:
        parent, target, depth = queue.pop(0)
        details = resolve_wikilink_details(target, parent)
        if details["status"] != "resolved":
            unresolved_details.append({
                "target": target,
                "source": relative(parent),
                "status": details["status"],
                "candidates": details["candidates"],
            })
            continue
        linked = details["path"]
        assert isinstance(linked, Path)
        resolved = linked.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        linked_text = read_text(linked)
        metadata = parse_frontmatter(linked_text)
        if depth > 1 and not is_style_profile(metadata):
            continue
        entry = {
            "path": relative(linked),
            "metadata": metadata,
            "content": linked_text,
            "link_depth": depth,
        }
        links.append(entry)
        if depth < max_link_depth and is_style_index(metadata):
            queue.extend((linked, child, depth + 1) for child in WIKILINK_RE.findall(linked_text))

    traversal_limited = bool(queue)

    scene_content = scene[:budget]
    result: dict[str, Any] = {
        "scene": {
            "path": relative(source),
            "sha256": sha256_text(scene),
            "metadata": parse_frontmatter(scene),
            "content": scene_content,
            "truncated": len(scene) > len(scene_content),
            "omitted_characters": max(0, len(scene) - len(scene_content)),
        },
        "linked_context": [],
        "unresolved_links": [item["target"] for item in unresolved_details],
        "unresolved_link_details": unresolved_details,
        "omitted_context": [],
    }
    budget_truncated = len(scene) > len(scene_content)
    used = len(scene_content)
    for entry in links:
        remaining = budget - used
        if remaining <= 0:
            budget_truncated = True
            result["omitted_context"].append({
                "path": entry["path"],
                "link_depth": entry["link_depth"],
                "reason": "budget",
                "omitted_characters": len(entry["content"]),
            })
            continue
        content = entry["content"]
        included = dict(entry)
        included["content"] = content[:remaining]
        included["truncated"] = len(content) > remaining
        included["omitted_characters"] = max(0, len(content) - len(included["content"]))
        result["linked_context"].append(included)
        used += len(included["content"])
        if included["truncated"]:
            budget_truncated = True
            result["omitted_context"].append({
                "path": entry["path"],
                "link_depth": entry["link_depth"],
                "reason": "budget",
                "omitted_characters": included["omitted_characters"],
            })
    if traversal_limited:
        result["omitted_context"].append({
            "reason": "link_limit",
            "limit": MAX_SCENE_CONTEXT_LINKS,
        })
    result["characters_used"] = used
    result["truncated_by_budget"] = budget_truncated
    result["traversal_limited"] = traversal_limited
    return result


def safe_slug(value: str) -> str:
    slug = re.sub(r"[^\w\-]+", "-", value.strip(), flags=re.UNICODE).strip("-").lower()
    return slug[:60] or "proposal"


def save_proposal(args: dict[str, Any]) -> dict[str, Any]:
    proposal_type = str(args.get("proposal_type") or "revision")
    if proposal_type not in {"revision", "continuation", "canon"}:
        raise TaleWispError("proposal_type must be revision, continuation, or canon")
    title = str(args.get("title") or "Untitled proposal").strip()
    replacement = str(args.get("replacement_text") or "")
    if not replacement:
        raise TaleWispError("replacement_text must not be empty")
    source_rel = str(args.get("source_path") or "").strip()
    source_hash = None
    if source_rel:
        source = resolve_user_path(source_rel)
        source_hash = sha256_text(read_text(source))

    proposal_id = f"{utc_stamp()}-{safe_slug(title)}"
    pending = STATE.root / ".talewisp" / "proposals" / "pending"
    pending.mkdir(parents=True, exist_ok=True)
    json_path = pending / f"{proposal_id}.json"
    counter = 2
    while json_path.exists():
        json_path = pending / f"{proposal_id}-{counter}.json"
        counter += 1
    preview_path = json_path.with_suffix(".md")
    payload = {
        "schema_version": 1,
        "id": json_path.stem,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "proposal_type": proposal_type,
        "title": title,
        "source_path": source_rel or None,
        "source_sha256": source_hash,
        "summary": str(args.get("summary") or ""),
        "evidence": args.get("evidence") or [],
        "replacement_text": replacement,
        "status": "pending",
    }
    extraction = args.get("continuity_extraction")
    if extraction is not None:
        module = extraction_module()
        payload["continuity_extraction"] = extraction
        try:
            module.validate_pending(STATE.root, payload, module.pending_preview(payload), None)
        except (ValueError, TypeError) as exc:
            raise TaleWispError(str(exc)) from exc
    elif safe_slug(title).startswith("continuity-extraction-"):
        raise TaleWispError("Reserved extraction proposal title requires its receipt")
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    preview = (
        "---\n"
        f"type: talewisp-proposal\nstatus: pending\nproposal_type: {proposal_type}\n"
        f"source_path: {json.dumps(source_rel, ensure_ascii=False)}\n---\n\n"
        f"# {title}\n\n{payload['summary']}\n\n## Proposed text\n\n{replacement}\n"
    )
    if extraction is not None:
        preview = module.pending_preview(payload)
    preview_path.write_text(preview, encoding="utf-8")
    return {
        "proposal": relative(json_path),
        "preview": relative(preview_path),
        "source_sha256": source_hash,
        "status": "pending",
    }


def apply_proposal(args: dict[str, Any]) -> dict[str, Any]:
    if args.get("confirmed") is not True:
        raise TaleWispError("Explicit confirmation is required: set confirmed to true only after user approval")
    proposal_rel = str(args.get("proposal_path") or "")
    proposal_path = resolve_user_path(proposal_rel)
    expected_parent = (STATE.root / ".talewisp" / "proposals" / "pending").resolve()
    try:
        proposal_path.resolve().relative_to(expected_parent)
    except ValueError as exc:
        raise TaleWispError("Only pending TaleWisp proposals can be applied") from exc
    if proposal_path.suffix.lower() != ".json":
        raise TaleWispError("proposal_path must point to a pending .json proposal")
    proposal = load_json(proposal_path)
    preview_path = proposal_path.with_suffix(".md")
    extraction_preview = preview_path.read_text(encoding="utf-8") if preview_path.exists() else ""
    if ("continuity_extraction" in proposal or "continuity-extraction-v1" in extraction_preview
            or "-continuity-extraction-" in proposal_path.stem):
        try:
            args = dict(args, target_path=extraction_module().validate_pending(
                STATE.root, proposal, extraction_preview, args.get("target_path")))
        except (ValueError, TypeError) as exc:
            raise TaleWispError(str(exc)) from exc
    source_rel = proposal.get("source_path")
    stamp = utc_stamp()
    backup = None
    if source_rel:
        source = resolve_user_path(str(source_rel))
        original = read_text(source)
        actual_hash = sha256_text(original)
        if actual_hash != proposal.get("source_sha256"):
            raise TaleWispError("Source changed after the proposal was created; regenerate the proposal")
        backup_root = STATE.root / ".talewisp" / "backups" / stamp
        backup = backup_root / relative(source)
        counter = 2
        while backup.exists():
            backup_root = STATE.root / ".talewisp" / "backups" / f"{stamp}-{counter}"
            backup = backup_root / relative(source)
            counter += 1
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, backup)
    else:
        target_rel = str(args.get("target_path") or "").strip()
        if not target_rel:
            raise TaleWispError("A standalone proposal requires target_path")
        source = resolve_user_path(target_rel, must_exist=False)
        if source.exists():
            raise TaleWispError("The target file already exists; create a revision proposal for it instead")
        source.parent.mkdir(parents=True, exist_ok=True)

    replacement = str(proposal.get("replacement_text") or "")
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=source.parent, suffix=".tmp") as handle:
        handle.write(replacement)
        temp_name = handle.name
    os.replace(temp_name, source)

    applied_dir = STATE.root / ".talewisp" / "proposals" / "applied"
    applied_dir.mkdir(parents=True, exist_ok=True)
    proposal["status"] = "applied"
    proposal["applied_at"] = datetime.now(timezone.utc).isoformat()
    proposal_path.write_text(json.dumps(proposal, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    applied_json = applied_dir / proposal_path.name
    shutil.move(str(proposal_path), applied_json)
    preview = proposal_path.with_suffix(".md")
    if preview.exists():
        shutil.move(str(preview), applied_dir / preview.name)
    return {
        "applied": relative(applied_json),
        "source": relative(source),
        "new_sha256": sha256_text(replacement),
        "backup": relative(backup) if backup else None,
    }


def build_series_base(args: dict[str, Any]) -> dict[str, Any]:
    """The importer owns its session; no profile or source-proposal mutations."""
    name = "talewisp_series_import"
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name("series_import.py"))
        if spec is None or spec.loader is None:
            raise TaleWispError("Series-base importer is unavailable")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    try:
        return module.build_series_base(STATE.root, args)
    except module.SeriesImportError as exc:
        raise TaleWispError(str(exc)) from exc


def storyart_links_module():
    name = "talewisp_storyart_links"
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name("storyart_links.py"))
        if spec is None or spec.loader is None:
            raise TaleWispError("StoryArt linkage module is unavailable")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return module


def storyart_link_action(action: str, args: dict[str, Any]) -> dict[str, Any]:
    try:
        return storyart_links_module().dispatch(STATE.root, action, args)
    except storyart_links_module().StoryArtLinkError as exc:
        raise TaleWispError(str(exc)) from exc


TOOLS = [
    {
        "name": "talewisp_model_selection",
        "description": "Resolve the model/effort before agent dispatch. Other selections require keep, once or project scope. Only project saves a project-local preference; this does not switch a running agent.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "effort": {"type": "string"},
                "choice": {"type": "string", "enum": ["keep", "once", "project"]},
                "project_root": {"type": "string", "description": "Startup project or an existing descendant"},
                "available_models": {"type": "object", "additionalProperties": {"type": "array", "items": {"type": "string"}, "minItems": 1}},
            },
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_build_series_base",
        "description": "Build a source-grounded base from mixed local FB2, TXT, Markdown, HTML, DOCX, EPUB or verified talewisp-source-snapshot-v1 JSON extractions of any external source. No automatic external fetching; unsupported/lossy raw formats require verified extraction. Start asks the author's pseudonym before reading; prepare preserves originals and provenance; finalize renders all nine analysis layers; check verifies exact reading/image coverage; accept requires independent review of the current candidate. Non-book sources need no invented scenes. Follow the build-series-base skill.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["start", "prepare", "status", "finalize", "check", "accept"]},
                "files": {"type": "array", "items": {"type": "string"}, "description": "Absolute paths of explicitly supplied mixed local sources or verified normalized JSON snapshots; original suffixes and hashes retained"},
                "source_kinds": {"type": "object", "additionalProperties": {"type": "string", "enum": ["book", "article", "notes", "document", "web", "audio", "video", "other"]}, "description": "Optional explicit mapping from exact supplied absolute file paths to source kind; use book for narrative prose in TXT/MD/DOCX to require scene partition coverage"},
                "author_pseudonym": {"type": "string", "description": "The pseudonym explicitly supplied by the human, never inferred from metadata or a profile"},
                "series_name": {"type": "string", "description": "Base/series project name; clarify only if source series metadata is missing or ambiguous"},
                "session_id": {"type": "string"},
                "analysis_path": {"type": "string", "description": "Vault-relative JSON analysis saved under this import session"},
                "review_path": {"type": "string", "description": "Vault-relative independent review JSON with PASS and current candidate_sha256"},
            },
            "required": ["action"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_select_vault",
        "description": "Select the local TaleWisp or Obsidian vault for this session and return its status.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Absolute local vault directory"}},
            "required": ["path"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_project_status",
        "description": "Summarize the active local story vault, file types, confirmed canon, and pending proposals.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_onboarding_status",
        "description": "Inspect author, style, series, and book setup state and recommend the next first-run route.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_list_files",
        "description": "List story files and their metadata, optionally filtered by TaleWisp type or folder.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "type": {"type": "string"},
                "folder": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 500},
            },
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_read_file",
        "description": "Read one UTF-8 Markdown or text file from the active story vault.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path relative to the active vault"},
                "max_chars": {"type": "integer", "minimum": 1000, "maximum": 200000},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_search",
        "description": "Search literal text across the local story vault and return source snippets.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "type": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_compare_style_edit",
        "description": "Compare a TaleWisp mini-scene with the author's edited version and measure the correction pattern without saving either text.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ai_text": {"type": "string", "description": "The exact TaleWisp-generated calibration text"},
                "author_text": {"type": "string", "description": "The author's direct edited version"},
            },
            "required": ["ai_text", "author_text"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_scene_context",
        "description": "Read a scene plus direct wikilinks and the linked style index's style-profile children. Content is capped by max_chars and reports omissions.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "max_chars": {"type": "integer", "minimum": 4000, "maximum": 160000},
                "max_link_depth": {"type": "integer", "minimum": 1, "maximum": 2, "description": "One direct-link level, optionally followed by style-index children"},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_save_proposal",
        "description": "Save a reviewable revision, continuation, or canon proposal without modifying the source manuscript. If source_path is set, replacement_text must contain the complete intended source file.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "proposal_type": {"type": "string", "enum": ["revision", "continuation", "canon"]},
                "title": {"type": "string"},
                "source_path": {"type": "string"},
                "replacement_text": {"type": "string", "description": "Complete intended source file when source_path is set; otherwise the standalone proposed content"},
                "summary": {"type": "string"},
                "evidence": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["proposal_type", "title", "replacement_text"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_apply_proposal",
        "description": "Apply a pending proposal after explicit user approval. Revisions verify the source hash and create a local backup; standalone proposals require a new target_path.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "proposal_path": {"type": "string"},
                "target_path": {"type": "string", "description": "New vault-relative file path for a standalone proposal without source_path"},
                "confirmed": {"type": "boolean", "description": "True only after explicit user approval"},
            },
            "required": ["proposal_path", "confirmed"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": True, "openWorldHint": False},
    },
    {
        "name": "talewisp_storyart_bind_character",
        "description": "Bind a TaleWisp character card to its StoryArt identity after explicit confirmation and an optimistic source hash check.",
        "inputSchema": {"type": "object", "properties": {
            "card_path": {"type": "string"}, "storyart_project_path": {"type": "string"},
            "storyart_style_pack": {"type": "string"}, "storyart_character_id": {"type": "string"},
            "storyart_character_name": {"type": "string"}, "expected_source_sha256": {"type": "string"},
            "confirmed": {"type": "boolean"}},
            "required": ["card_path", "storyart_project_path", "storyart_style_pack", "storyart_character_id", "storyart_character_name", "expected_source_sha256", "confirmed"],
            "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": True, "openWorldHint": False},
    },
    {
        "name": "talewisp_storyart_resolve_character",
        "description": "Resolve the StoryArt style and character identity bound to one TaleWisp character card.",
        "inputSchema": {"type": "object", "properties": {"card_path": {"type": "string"}, "storyart_style_pack": {"type": "string"}, "storyart_character_id": {"type": "string"}}, "required": ["card_path"], "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_storyart_stage_art",
        "description": "Stage a StoryArt candidate in the active vault. Staging does not approve or publish art.",
        "inputSchema": {"type": "object", "properties": {"request": {"type": "object", "description": "Candidate JSON with pair_id, generation_id, image_path, image_sha256, StoryArt project/thread/identity and vault-relative source_refs or targets."}, "expected_candidate_sha256": {"type": "string", "description": "Required optimistic guard only when replacing a pending candidate with this pair_id."}}, "required": ["request"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_storyart_confirm_art",
        "description": "Publish one staged illustration after explicit author confirmation, visual and canon PASS, matching current image digest, and a StoryArt APPROVED receipt.",
        "inputSchema": {"type": "object", "properties": {"pair_id": {"type": "string"}, "destination_path": {"type": "string"}, "receipt_path": {"type": "string"}, "confirmed": {"type": "boolean"}}, "required": ["pair_id", "destination_path", "receipt_path", "confirmed"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_storyart_list_art",
        "description": "List staged StoryArt candidates and published TaleWisp illustration associations.",
        "inputSchema": {"type": "object", "properties": {"pair_id": {"type": "string"}, "approved_only": {"type": "boolean"}}, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_storyart_validate",
        "description": "Validate StoryArt linkage lifecycle records and current approved image digests.",
        "inputSchema": {"type": "object", "properties": {"pair_id": {"type": "string"}}, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "talewisp_storyart_context",
        "description": "Resolve confirmed illustration cards linked to one TaleWisp source path; pending candidates are excluded.",
        "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
]


HANDLERS = {
    "talewisp_model_selection": model_selection,
    "talewisp_build_series_base": build_series_base,
    "talewisp_select_vault": select_vault,
    "talewisp_project_status": project_status,
    "talewisp_onboarding_status": onboarding_status,
    "talewisp_list_files": list_files,
    "talewisp_read_file": read_file,
    "talewisp_search": search_story,
    "talewisp_compare_style_edit": compare_style_edit,
    "talewisp_scene_context": scene_context,
    "talewisp_save_proposal": save_proposal,
    "talewisp_apply_proposal": apply_proposal,
    "talewisp_storyart_bind_character": lambda args: storyart_link_action("bind-character", args),
    "talewisp_storyart_resolve_character": lambda args: storyart_link_action("resolve-character", args),
    "talewisp_storyart_stage_art": lambda args: storyart_link_action("stage-art", args),
    "talewisp_storyart_confirm_art": lambda args: storyart_link_action("confirm-art", args),
    "talewisp_storyart_list_art": lambda args: storyart_link_action("list-art", args),
    "talewisp_storyart_validate": lambda args: storyart_link_action("validate", args),
    "talewisp_storyart_context": lambda args: storyart_link_action("context", args),
}


def extraction_module():
    name = "talewisp_continuity_extraction"
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name("continuity_extraction.py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return module


def extraction_action(action: str, args: dict[str, Any]) -> dict[str, Any]:
    module = extraction_module()
    try:
        if action == "prepare":
            return module.prepare(STATE.root, args.get("source_paths"))
        return module.stage(STATE.root, args, save_proposal)
    except (ValueError, TypeError) as exc:
        raise TaleWispError(str(exc)) from exc


def continuity_action(action: str, args: dict[str, Any]) -> dict[str, Any]:
    name = "talewisp_continuity"
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name("continuity_check.py"))
        if spec is None or spec.loader is None:
            raise TaleWispError("Continuity helper is unavailable")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    try:
        return module.dispatch(STATE.root, action, args)
    except module.ContinuityError as exc:
        raise TaleWispError(str(exc)) from exc


TOOLS.extend([
    {"name": "talewisp_prepare_continuity_extraction", "description": "Read complete bounded supplied MD/TXT sources for host-agent extraction and independent semantic review. No model client or canon writes.",
     "inputSchema": {"type": "object", "properties": {"source_paths": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 16}}, "required": ["source_paths"], "additionalProperties": False}},
    {"name": "talewisp_stage_continuity_extraction", "description": "Only on explicit save request: validate full source-bound candidate and independent review, then save a pending author-controlled continuity JSON proposal.",
     "inputSchema": {"type": "object", "properties": {"source_paths": {"type": "array", "items": {"type": "string"}}, "source_packet_sha256": {"type": "string"}, "candidate": {"type": "object"}, "review": {"type": "object"}, "target_path": {"type": "string"}, "title": {"type": "string"}}, "required": ["source_paths", "source_packet_sha256", "candidate", "review", "target_path"], "additionalProperties": False}},
    {"name": "talewisp_continuity_check", "description": "Read-only deterministic audit of explicit source-bound listed continuity records. No global canon PASS.",
     "inputSchema": {"type": "object", "properties": {"contract_path": {"type": "string"}}, "required": ["contract_path"], "additionalProperties": False}},
    {"name": "talewisp_knowledge_at_scene", "description": "Read-only start-of-scene projection separating character knowledge and reader access, using trusted source-bound records.",
     "inputSchema": {"type": "object", "properties": {"contract_path": {"type": "string"}, "scene_id": {"type": "string"}, "entity_id": {"type": "string"}}, "required": ["contract_path", "scene_id", "entity_id"], "additionalProperties": False}},
])
HANDLERS.update({
    "talewisp_prepare_continuity_extraction": lambda args: extraction_action("prepare", args),
    "talewisp_stage_continuity_extraction": lambda args: extraction_action("stage", args),
    "talewisp_continuity_check": lambda args: continuity_action("check", args),
    "talewisp_knowledge_at_scene": lambda args: continuity_action("knowledge", args),
})


def google_workspace_module():
    name = "talewisp_google_workspace"
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name("google_workspace.py"))
        if spec is None or spec.loader is None:
            raise TaleWispError("Google Workspace helper module is unavailable")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return module


def google_workspace_action(name: str, args: dict[str, Any]) -> dict[str, Any]:
    module = google_workspace_module()
    try:
        return module.HANDLERS[name](args)
    except (module.GoogleWorkspaceError, KeyError, TypeError, UnicodeError) as exc:
        raise TaleWispError(f"Google Workspace input rejected: {exc}") from exc


TOOLS.extend(google_workspace_module().TOOLS)
HANDLERS.update({name: (lambda args, action=name: google_workspace_action(action, args))
                 for name in google_workspace_module().HANDLERS})


def tool_result(data: dict[str, Any], *, is_error: bool = False) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False, indent=2)}],
        "structuredContent": data,
        "isError": is_error,
    }


def handle(request: dict[str, Any]) -> dict[str, Any] | None:
    method = request.get("method")
    request_id = request.get("id")
    if request_id is None:
        return None
    try:
        if method == "initialize":
            protocol = request.get("params", {}).get("protocolVersion") or DEFAULT_PROTOCOL
            result = {
                "protocolVersion": protocol,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            }
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            params = request.get("params") or {}
            name = params.get("name")
            if name not in HANDLERS:
                raise TaleWispError(f"Unknown TaleWisp tool: {name}")
            result = tool_result(HANDLERS[name](params.get("arguments") or {}))
        elif method == "resources/list":
            result = {"resources": []}
        elif method == "prompts/list":
            result = {"prompts": []}
        else:
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}
        return {"jsonrpc": "2.0", "id": request_id, "result": result}
    except TaleWispError as exc:
        if method == "tools/call":
            return {"jsonrpc": "2.0", "id": request_id, "result": tool_result({"error": str(exc)}, is_error=True)}
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32000, "message": str(exc)}}
    except Exception as exc:
        print(f"TaleWisp internal error: {exc}", file=sys.stderr, flush=True)
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32603, "message": "Internal TaleWisp error"}}


def main() -> None:
    def write_protocol_response(response: dict[str, Any]) -> None:
        payload = json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n"
        sys.stdout.buffer.write(payload.encode("utf-8"))
        sys.stdout.buffer.flush()

    for raw in sys.stdin.buffer:
        try:
            request = json.loads(raw.decode("utf-8"))
            response = handle(request)
            if response is not None:
                write_protocol_response(response)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Parse error: {exc}"}}
            write_protocol_response(response)


if __name__ == "__main__":
    main()
