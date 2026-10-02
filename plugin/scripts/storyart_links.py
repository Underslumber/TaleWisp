"""Vault-local, confirmation-gated links between TaleWisp and StoryArt.

This module never writes to a StoryArt project or copies its image files. It
stores only a staged request and, after two independent approvals, a Markdown
record with Obsidian links back to TaleWisp sources.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path, PureWindowsPath
from typing import Any


class StoryArtLinkError(ValueError):
    pass


SAFE_PAIR = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
YAML_START = re.compile(r"\A---(?:\r?\n)")


def _inside(root: Path, path: Path) -> Path:
    root = root.resolve()
    resolved = path.resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise StoryArtLinkError("Path escapes the active TaleWisp vault") from exc
    return resolved


def _vault_path(root: Path, value: Any, *, must_exist: bool = True) -> Path:
    if not isinstance(value, str) or not value.strip() or Path(value).is_absolute():
        raise StoryArtLinkError("Expected a non-empty vault-relative path")
    candidate = _inside(root, root / value.replace("\\", "/"))
    if must_exist and not candidate.is_file():
        raise StoryArtLinkError(f"Vault file not found: {value}")
    return candidate


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _normalized_absolute(value: Any) -> str | None:
    if not isinstance(value, str) or not PureWindowsPath(value).is_absolute():
        return None
    return str(Path(value).resolve()).replace("\\", "/").rstrip("/").casefold()


def _safe_pair(value: Any) -> str:
    if not isinstance(value, str) or not SAFE_PAIR.fullmatch(value):
        raise StoryArtLinkError("pair_id must contain only letters, digits, dot, underscore, or hyphen")
    return value


def _frontmatter(text: str) -> tuple[str, str, str]:
    match = YAML_START.match(text)
    if not match:
        return "", "", text
    end = re.search(r"(?m)^---[ \t]*(?:\r?\n|$)", text[match.end():])
    if not end:
        raise StoryArtLinkError("Malformed YAML frontmatter")
    stop = match.end() + end.end()
    return text[:match.end()], text[match.end():stop], text[stop:]


def _parse_flat(text: str) -> dict[str, Any]:
    _start, header, _body = _frontmatter(text)
    values: dict[str, Any] = {}
    for line in header.splitlines()[:-1]:
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*?)\s*$", line)
        if not m:
            continue
        key, raw = m.groups()
        if key in values:
            raise StoryArtLinkError(f"Duplicate frontmatter key: {key}")
        if raw.startswith('"'):
            try:
                values[key] = json.loads(raw)
                continue
            except json.JSONDecodeError:
                pass
        if raw.startswith("[") or raw.startswith("{") or raw in {"true", "false", "null"}:
            try:
                values[key] = json.loads(raw)
                continue
            except json.JSONDecodeError:
                pass
        values[key] = raw.strip('"\'')
    return values


def _yaml_scalar(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _edit_flat_fields(original: str, updates: dict[str, Any]) -> str:
    prefix, header, body = _frontmatter(original)
    newline = "\r\n" if "\r\n" in original else "\n"
    if not prefix:
        lines = ["---"]
        lines.extend(f"{key}: {_yaml_scalar(value)}" for key, value in updates.items())
        lines.append("---")
        return newline.join(lines) + newline + original
    lines = header.splitlines(keepends=True)
    ending = "\r\n" if any(line.endswith("\r\n") for line in lines) else "\n"
    found: set[str] = set()
    output = []
    for line in lines:
        m = re.match(r"^([A-Za-z0-9_-]+):", line)
        if m and m.group(1) in updates:
            key = m.group(1)
            if key in found:
                raise StoryArtLinkError(f"Duplicate frontmatter key: {key}")
            found.add(key)
            output.append(f"{key}: {_yaml_scalar(updates[key])}{ending}")
        else:
            output.append(line)
    # Insert missing fields immediately before the closing delimiter.
    close_index = len(output) - 1
    for key, value in updates.items():
        if key not in found:
            output.insert(close_index, f"{key}: {_yaml_scalar(value)}{ending}")
            close_index += 1
    return prefix + "".join(output) + body


def _atomic_write(path: Path, payload: bytes, *, replace: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not replace:
        raise StoryArtLinkError(f"Destination already exists: {path}")
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        if not replace and path.exists():
            raise StoryArtLinkError(f"Destination already exists: {path}")
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def bind_character(root: Path, args: dict[str, Any]) -> dict[str, Any]:
    if args.get("confirmed") is not True:
        raise StoryArtLinkError("Character binding requires confirmed=true")
    card_rel = args.get("card_path")
    card = _vault_path(root, card_rel)
    original = card.read_bytes()
    current_sha = hashlib.sha256(original).hexdigest()
    if args.get("expected_source_sha256") != current_sha:
        raise StoryArtLinkError("Character card changed; expected_source_sha256 does not match")
    try:
        text = original.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise StoryArtLinkError("Character card is not UTF-8") from exc
    meta = _parse_flat(text)
    if not (meta.get("type") == "character" or
            (meta.get("record_kind") == "entity" and meta.get("entity_kind") == "character")):
        raise StoryArtLinkError("Target card is not a character record")
    fields = ("storyart_project_path", "storyart_style_pack", "storyart_character_id", "storyart_character_name")
    updates = {key: args.get(key) for key in fields}
    if any(not isinstance(value, str) or not value.strip() for value in updates.values()):
        raise StoryArtLinkError("All four StoryArt binding fields must be non-empty strings")
    project = Path(updates["storyart_project_path"])
    if not project.is_absolute() or not project.is_dir():
        raise StoryArtLinkError("StoryArt project path must be an existing absolute project directory")
    updates["storyart_project_path"] = str(project.resolve())
    new = _edit_flat_fields(text, updates).encode("utf-8")
    backup = root / ".talewisp" / "backups" / "storyart-bind" / f"{card.name}.{current_sha[:12]}.bak"
    rel_identity = hashlib.sha256(Path(card_rel).as_posix().encode("utf-8")).hexdigest()[:10]
    backup = backup.with_name(f"{rel_identity}.{backup.name}")
    backup = _inside(root, backup)
    if backup.exists() and backup.read_bytes() != original:
        raise StoryArtLinkError("Existing character backup conflicts with the current source bytes")
    if not backup.exists():
        _atomic_write(backup, original, replace=False)
    _atomic_write(card, new, replace=True)
    return {"card_path": Path(card_rel).as_posix(), "sha256": hashlib.sha256(new).hexdigest(),
            "backup": backup.relative_to(root).as_posix()}


def resolve_character(root: Path, args: dict[str, Any]) -> dict[str, Any]:
    card_rel = args.get("card_path")
    card = _vault_path(root, card_rel)
    meta = _parse_flat(card.read_text(encoding="utf-8"))
    if not (meta.get("type") == "character" or
            (meta.get("record_kind") == "entity" and meta.get("entity_kind") == "character")):
        raise StoryArtLinkError("Target card is not a character record")
    style = meta.get("storyart_style_pack")
    character_id = meta.get("storyart_character_id")
    if not isinstance(style, str) or not style.strip() or not isinstance(character_id, str) or not character_id.strip():
        raise StoryArtLinkError("Character card has no complete StoryArt style/character binding")
    if args.get("storyart_style_pack", style) != style or args.get("storyart_character_id", character_id) != character_id:
        raise StoryArtLinkError("Requested StoryArt identity does not match this character card")
    project = meta.get("storyart_project_path")
    if not isinstance(project, str) or not project:
        raise StoryArtLinkError("Character card has no StoryArt project path")
    if not Path(project).is_absolute() or not Path(project).is_dir():
        raise StoryArtLinkError("StoryArt project path in character card must be an existing absolute project directory")
    return {k: meta[k] for k in ("storyart_project_path", "storyart_style_pack", "storyart_character_id", "storyart_character_name")}


def _validate_ref(root: Path, ref: Any) -> dict[str, str]:
    if not isinstance(ref, dict) or not isinstance(ref.get("path"), str):
        raise StoryArtLinkError("Each source_ref must be an object with a vault-relative path")
    rel, anchor = _split_reference(ref["path"])
    path = _vault_path(root, rel)
    if anchor and not _fragment_exists(path, anchor):
        raise StoryArtLinkError(f"Fragment does not exist in source: {ref['path']}")
    role = ref.get("role", "reference")
    if not isinstance(role, str) or not role.strip():
        raise StoryArtLinkError("source_ref role must be a non-empty string")
    return {"path": Path(rel).as_posix() + (f"#{anchor}" if anchor else ""), "role": role}


def _split_reference(value: str) -> tuple[str, str]:
    rel, marker, anchor = value.partition("#")
    if not rel or (marker and not anchor):
        raise StoryArtLinkError("Source reference requires a file and a non-empty fragment when # is present")
    return rel.replace("\\", "/"), anchor


def _fragment_exists(path: Path, anchor: str) -> bool:
    content = path.read_text(encoding="utf-8")
    block_anchor = anchor[1:] if anchor.startswith("^") else anchor
    heading_ok = any(line.lstrip("# ").strip() == block_anchor for line in content.splitlines() if line.startswith("#"))
    block_ok = re.search(rf"(?m)(?:^|\s)\^{re.escape(block_anchor)}\s*$", content) is not None
    return heading_ok or block_ok


def _normalize_source_ref(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.replace("\\", "/")
    if normalized.startswith("vault/"):
        normalized = normalized[6:]
    file_part, marker, fragment = normalized.partition("#")
    return Path(file_part).as_posix() + (marker + fragment if marker else "")


def _request_path(root: Path, pair: str) -> Path:
    return _inside(root, root / ".talewisp" / "storyart" / "requests" / f"{pair}.json")


def stage_art(root: Path, args: dict[str, Any]) -> dict[str, Any]:
    request = args.get("request", args)
    if not isinstance(request, dict):
        raise StoryArtLinkError("request must be a JSON object")
    pair = _safe_pair(request.get("pair_id"))
    required = ("generation_id", "image_path", "image_sha256", "storyart_project_path", "storyart_thread_id")
    if any(not isinstance(request.get(k), str) or not request[k].strip() for k in required):
        raise StoryArtLinkError("Staged request is missing a required string field")
    project = Path(request["storyart_project_path"])
    if not project.is_absolute() or not project.is_dir():
        raise StoryArtLinkError("StoryArt project path must be an existing absolute project directory")
    project = project.resolve()
    image = Path(request["image_path"])
    if not image.is_absolute() or not image.is_file():
        raise StoryArtLinkError("image_path must point to an existing absolute StoryArt artifact")
    try:
        image.resolve().relative_to(project)
    except ValueError as exc:
        raise StoryArtLinkError("Image artifact must be inside the bound StoryArt project") from exc
    if _sha(image) != request["image_sha256"]:
        raise StoryArtLinkError("Image digest does not match the staged request")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", request["image_sha256"]):
        raise StoryArtLinkError("image_sha256 must be a 64-character SHA-256 digest")
    storyart_project = str(project)
    if not isinstance(request.get("storyart_style_pack"), str) or not request["storyart_style_pack"]:
        raise StoryArtLinkError("Staged request requires a StoryArt style pack")
    character_id = request.get("storyart_character_id")
    bindings = request.get("character_bindings", [])
    if character_id is not None and (not isinstance(character_id, str) or not character_id.strip()):
        raise StoryArtLinkError("storyart_character_id must be a non-empty string when supplied")
    if not isinstance(bindings, list):
        raise StoryArtLinkError("character_bindings must be an array")
    refs = request.get("source_refs")
    targets = request.get("targets")
    if refs is None and isinstance(targets, list):
        refs = [{"path": target.get("reference"), "role": target.get("kind", "reference")}
                for target in targets if isinstance(target, dict)]
    if not isinstance(refs, list) or not refs:
        raise StoryArtLinkError("At least one source_ref is required")
    canonical = dict(request)
    canonical["storyart_project_path"] = storyart_project
    canonical["source_refs"] = [_validate_ref(root, ref) for ref in refs]
    # Verify referenced character card binding where supplied.
    char_refs = [ref for ref in canonical["source_refs"] if ref["role"] == "character"]
    binding_map = {entry.get("path"): entry for entry in bindings if isinstance(entry, dict)}
    for ref in char_refs:
        card = _vault_path(root, ref["path"].split("#", 1)[0])
        meta = _parse_flat(card.read_text(encoding="utf-8"))
        if not (meta.get("type") == "character" or
                (meta.get("record_kind") == "entity" and meta.get("entity_kind") == "character")):
            raise StoryArtLinkError(f"Character source ref is not a character card: {ref['path']}")
        identity = binding_map.get(ref["path"], {})
        wanted_style = identity.get("style_pack", canonical["storyart_style_pack"])
        wanted_id = identity.get("character_id", canonical.get("storyart_character_id"))
        if not wanted_id or meta.get("storyart_style_pack") != wanted_style or meta.get("storyart_character_id") != wanted_id:
            raise StoryArtLinkError("Character card StoryArt binding does not match the staged style/ID")
        if meta.get("storyart_project_path") != storyart_project:
            raise StoryArtLinkError("Character card project path does not match the staged request")
    if len(char_refs) > 1 and any(ref["path"] not in binding_map for ref in char_refs):
        raise StoryArtLinkError("Multiple character refs require one character_bindings identity for each card")
    canonical.update({"schema_version": 1, "status": "pending", "visual_qa": request.get("visual_qa", "PENDING"),
                      "canon_qa": request.get("canon_qa", "PENDING")})
    target = _request_path(root, pair)
    payload = (json.dumps(canonical, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if target.exists():
        current = target.read_bytes()
        current_hash = hashlib.sha256(current).hexdigest()
        if current == payload:
            return {"pair_id": pair, "candidate_path": target.relative_to(root).as_posix(), "candidate_sha256": current_hash, "status": "pending", "replayed": True}
        try:
            previous = json.loads(current.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise StoryArtLinkError("Existing candidate is malformed; refusing replacement") from exc
        if previous.get("status") == "APPROVED":
            raise StoryArtLinkError("Approved pairs cannot be replaced with the same pair_id")
        if previous.get("status") != "pending":
            raise StoryArtLinkError("Only a pending candidate can be explicitly replaced")
        if args.get("expected_candidate_sha256") != current_hash:
            raise StoryArtLinkError("Replacing a pending candidate requires its matching expected_candidate_sha256")
        history = _inside(root, root / ".talewisp" / "storyart" / "history" / pair / f"{current_hash}.json")
        if history.exists() and history.read_bytes() != current:
            raise StoryArtLinkError("Candidate history digest path conflicts with different bytes")
        if not history.exists():
            _atomic_write(history, current, replace=False)
        _atomic_write(target, payload, replace=True)
        return {"pair_id": pair, "candidate_path": target.relative_to(root).as_posix(), "candidate_sha256": hashlib.sha256(payload).hexdigest(), "status": "pending", "replayed": False, "replaced_sha256": current_hash, "history_path": history.relative_to(root).as_posix()}
    _atomic_write(target, payload, replace=False)
    return {"pair_id": pair, "candidate_path": target.relative_to(root).as_posix(), "candidate_sha256": hashlib.sha256(payload).hexdigest(), "status": "pending", "replayed": False}


def _receipt(path_value: Any, project_path: str) -> dict[str, Any]:
    if not isinstance(path_value, str) or not Path(path_value).is_absolute():
        raise StoryArtLinkError("receipt_path must be an absolute StoryArt approval receipt path")
    receipt_path = Path(path_value).resolve()
    try:
        receipt_path.relative_to(Path(project_path).resolve())
    except ValueError as exc:
        raise StoryArtLinkError("StoryArt receipt must be inside the bound StoryArt project") from exc
    try:
        data = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise StoryArtLinkError(f"Cannot read StoryArt receipt: {exc}") from exc
    if not isinstance(data, dict):
        raise StoryArtLinkError("StoryArt receipt must be a JSON object")
    return data


def _same_receipt(req: dict[str, Any], receipt: dict[str, Any]) -> None:
    storyart = receipt.get("storyart") or {}
    checks = {
        "pair_id": req["pair_id"],
        "sha256": req["image_sha256"],
        "visual_qa": "PASS", "canon_qa": "PASS",
    }
    for key, expected in checks.items():
        if receipt.get(key) != expected:
            raise StoryArtLinkError(f"StoryArt receipt mismatch: {key}")
    if receipt.get("status") not in {"APPROVED", "APPROVED_SCENE"}:
        raise StoryArtLinkError("StoryArt receipt is not approved")
    _author_approval_quote(receipt)
    generation = receipt.get("generation_id")
    if generation != req["generation_id"] and receipt.get("parent_generation_id") != req["generation_id"]:
        raise StoryArtLinkError("StoryArt receipt generation does not match the staged generation or its explicit parent")
    registered = receipt.get("registered_image_path")
    if not isinstance(registered, str) or not Path(registered).is_absolute():
        raise StoryArtLinkError("StoryArt receipt must contain an absolute registered_image_path")
    approved_image = Path(registered).resolve()
    try:
        approved_image.relative_to(Path(req["storyart_project_path"]).resolve())
    except ValueError as exc:
        raise StoryArtLinkError("Approved image path must be inside the bound StoryArt project") from exc
    staged_image = Path(req["image_path"])
    if (not approved_image.is_file() or not staged_image.is_file() or
            _sha(approved_image) != req["image_sha256"] or _sha(staged_image) != req["image_sha256"]):
        raise StoryArtLinkError("Staged and approved image files must both exist with the exact staged digest")
    for key, expected in (("style_pack", req["storyart_style_pack"]), ("character_id", req.get("storyart_character_id"))):
        if expected is not None and storyart.get(key) != expected:
            raise StoryArtLinkError(f"StoryArt receipt mismatch: storyart.{key}")
    if _normalized_absolute(storyart.get("project_path")) != _normalized_absolute(req["storyart_project_path"]):
        raise StoryArtLinkError("StoryArt receipt mismatch: storyart.project_path")
    expected_name = req.get("storyart_character_name")
    if expected_name and storyart.get("character_name") != expected_name:
        raise StoryArtLinkError("StoryArt receipt mismatch: storyart.character_name")
    expected_talewisp = req.get("talewisp_project_path")
    if expected_talewisp and _normalized_absolute(receipt.get("talewisp_project_path")) != _normalized_absolute(expected_talewisp):
        raise StoryArtLinkError("StoryArt receipt mismatch: talewisp_project_path")
    targets = receipt.get("targets")
    if not isinstance(targets, list):
        raise StoryArtLinkError("StoryArt receipt targets must be present as an array")
    expected_targets = {(ref["role"], _normalize_source_ref(ref["path"])) for ref in req["source_refs"]}
    actual_targets = []
    for target in targets:
        if not isinstance(target, dict) or not isinstance(target.get("kind"), str):
            raise StoryArtLinkError("Every StoryArt receipt target must have kind and reference")
        reference = _normalize_source_ref(target.get("reference"))
        if reference is None:
            raise StoryArtLinkError("Every StoryArt receipt target must have a string reference")
        actual_targets.append((target["kind"], reference))
    if len(actual_targets) != len(set(actual_targets)) or set(actual_targets) != expected_targets:
        raise StoryArtLinkError("StoryArt receipt targets must exactly match staged source refs including anchors")
    legacy_fields = {"character_path": "character", "scene_path": "scene", "event_reference": "event"}
    for field, kind in legacy_fields.items():
        if field not in receipt:
            continue
        actual = _normalize_source_ref(receipt[field])
        allowed = {path for target_kind, path in expected_targets if target_kind == kind}
        if actual not in allowed:
            raise StoryArtLinkError(f"StoryArt receipt source does not match the exact staged reference: {field}")


def _author_approval_quote(receipt: dict[str, Any]) -> str:
    approval = receipt.get("author_approval")
    quote = receipt.get("author_approval_quote")
    if isinstance(approval, str) and approval.strip().upper() == "GIVEN":
        if isinstance(quote, str) and quote.strip():
            return quote.strip()
        raise StoryArtLinkError("StoryArt receipt marks approval GIVEN but has no author_approval_quote")
    if not isinstance(approval, str) or not approval.strip():
        raise StoryArtLinkError("StoryArt receipt lacks explicit author approval evidence")
    value = approval.strip()
    if value.upper() in {"NOT_GIVEN", "TRUE", "FALSE", "APPROVED", "APPROVED_SCENE", "PASS", "TEST", "PENDING", "REJECTED"}:
        raise StoryArtLinkError("StoryArt receipt author_approval must contain a quote or GIVEN with author_approval_quote")
    return value


def _art_card(req: dict[str, Any], receipt: dict[str, Any], candidate_path: str) -> bytes:
    safe = req["pair_id"]
    refs = req["source_refs"]
    title = req.get("title") or f"Иллюстрация {safe}"
    metadata = {
        "type": "illustration", "title": title, "pair_id": safe,
        "storyart_project_path": req["storyart_project_path"],
        "storyart_style_pack": req["storyart_style_pack"],
        "storyart_character_id": req.get("storyart_character_id"),
        "storyart_character_name": req.get("storyart_character_name", ""),
        "generation_id": req["generation_id"], "image_path": req["image_path"],
        "image_sha256": req["image_sha256"], "storyart_status": receipt["status"],
        "visual_qa": "PASS", "canon_qa": "PASS", "author_approval": "GIVEN",
        "author_approval_quote": _author_approval_quote(receipt),
        "candidate_path": candidate_path,
        "source_refs": [r["path"] for r in refs],
    }
    lines = ["---"] + [f"{k}: {_yaml_scalar(v)}" for k, v in metadata.items()] + ["---", "", f"# {title}", "", "Источники:"]
    for ref in refs:
        target = ref["path"].replace("\\", "/")
        lines.append(f"- {ref['role']}: [[{target}]]")
    lines.extend(["", f"StoryArt generation: `{req['generation_id']}`; SHA-256: `{req['image_sha256']}`.", ""])
    return "\n".join(lines).encode("utf-8")


def confirm_art(root: Path, args: dict[str, Any]) -> dict[str, Any]:
    if args.get("confirmed") is not True:
        raise StoryArtLinkError("Publishing illustration requires confirmed=true")
    pair = _safe_pair(args.get("pair_id"))
    candidate_path = _request_path(root, pair)
    try:
        req = json.loads(candidate_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise StoryArtLinkError(f"Cannot read staged candidate: {exc}") from exc
    if req.get("pair_id") != pair:
        raise StoryArtLinkError("Candidate pair_id mismatch")
    if req.get("status") not in {"pending", "APPROVED"}:
        raise StoryArtLinkError("Candidate lifecycle status is not confirmable")
    if req.get("visual_qa") != "PASS" or req.get("canon_qa") != "PASS":
        raise StoryArtLinkError("Both visual_qa and canon_qa must be PASS before confirmation")
    image = Path(req["image_path"])
    if not image.is_absolute() or not image.is_file() or _sha(image) != req["image_sha256"]:
        raise StoryArtLinkError("Staged image is missing or changed since staging")
    receipt = _receipt(args.get("receipt_path"), req["storyart_project_path"])
    _same_receipt(req, receipt)
    destination = _vault_path(root, args.get("destination_path"), must_exist=False)
    if destination.suffix.lower() != ".md":
        raise StoryArtLinkError("Art-card destination must be a Markdown file")
    art_req = dict(req)
    art_req["generation_id"] = receipt["generation_id"]
    art_req["image_path"] = str(Path(receipt["registered_image_path"]).resolve())
    payload = _art_card(art_req, receipt, candidate_path.relative_to(root).as_posix())
    destination_rel = destination.relative_to(root).as_posix()
    if req.get("status") == "APPROVED":
        if req.get("published_path") != destination_rel:
            raise StoryArtLinkError("This approved pair_id is already published to a different destination")
        if (not destination.is_file() or destination.read_bytes() != payload or
                hashlib.sha256(destination.read_bytes()).hexdigest() != req.get("art_note_sha256")):
            raise StoryArtLinkError("Approved art card changed since publication")
        return {"pair_id": pair, "status": "APPROVED", "art_card_path": destination_rel, "replayed": True}
    if destination.exists():
        if destination.read_bytes() != payload:
            raise StoryArtLinkError("Destination exists with different content")
    else:
        _atomic_write(destination, payload, replace=False)
    req["staged_generation_id"] = req["generation_id"]
    req["staged_image_path"] = req["image_path"]
    req["status"] = "APPROVED"
    req["approved_generation_id"] = receipt["generation_id"]
    req["approved_image_path"] = str(Path(receipt["registered_image_path"]).resolve())
    req["approved_status"] = receipt["status"]
    req["author_approval_quote"] = _author_approval_quote(receipt)
    req["published_path"] = destination_rel
    req["art_note_sha256"] = hashlib.sha256(payload).hexdigest()
    req["receipt_sha256"] = hashlib.sha256(json.dumps(receipt, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    _atomic_write(candidate_path, (json.dumps(req, ensure_ascii=False, indent=2) + "\n").encode("utf-8"), replace=True)
    return {"pair_id": pair, "status": "APPROVED", "art_card_path": req["published_path"], "replayed": False}


def list_art(root: Path, args: dict[str, Any]) -> dict[str, Any]:
    only = args.get("pair_id")
    if only is not None:
        pairs = [_safe_pair(only)]
    else:
        folder = _inside(root, root / ".talewisp" / "storyart" / "requests")
        pairs = sorted(path.stem for path in folder.glob("*.json")) if folder.is_dir() else []
    items = []
    for pair in pairs:
        path = _request_path(root, pair)
        if not path.is_file():
            continue
        item = json.loads(path.read_text(encoding="utf-8"))
        if args.get("approved_only") is True and item.get("status") != "APPROVED":
            continue
        row = _authoritative_item(item)
        row["candidate_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        row["validation_errors"] = _candidate_errors(root, item)
        row["valid"] = not row["validation_errors"]
        items.append(row)
    return {"items": items, "count": len(items)}


def _candidate_errors(root: Path, item: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    approved = item.get("status") == "APPROVED"
    image_value = item.get("approved_image_path") if approved else item.get("image_path")
    image = Path(image_value or "")
    project_value = item.get("storyart_project_path")
    try:
        project = Path(project_value).resolve()
        resolved_image = image.resolve()
        resolved_image.relative_to(project)
        if not resolved_image.is_file() or _sha(resolved_image) != item.get("image_sha256"):
            errors.append("approved image is missing or its digest changed" if approved else "staged image is missing or its digest changed")
    except (OSError, ValueError, TypeError):
        errors.append("image path is invalid or outside the bound StoryArt project")
    refs = item.get("source_refs")
    if not isinstance(refs, list) or not refs:
        errors.append("source_refs are missing")
    else:
        for ref in refs:
            try:
                _validate_ref(root, ref)
            except (StoryArtLinkError, OSError, UnicodeError) as exc:
                errors.append(f"source reference is stale: {ref.get('path') if isinstance(ref, dict) else ref}: {exc}")
    if approved:
        published_path = item.get("published_path")
        try:
            note = _vault_path(root, published_path)
            note_bytes = note.read_bytes()
            note_hash = hashlib.sha256(note_bytes).hexdigest()
            if note_hash != item.get("art_note_sha256"):
                errors.append("published art note changed since confirmation")
            else:
                errors.extend(_published_note_mismatches(root, item, note_bytes))
        except (StoryArtLinkError, OSError, TypeError) as exc:
            errors.append(f"published art note is missing or unsafe: {exc}")
    elif item.get("status") != "pending":
        errors.append("unknown candidate lifecycle status")
    return errors


def _published_note_mismatches(root: Path, item: dict[str, Any], payload: bytes) -> list[str]:
    try:
        text = payload.decode("utf-8")
        metadata = _parse_flat(text)
    except (UnicodeDecodeError, StoryArtLinkError) as exc:
        return [f"published art note metadata is invalid: {exc}"]
    refs = item.get("source_refs")
    expected_refs = [ref.get("path") for ref in refs] if isinstance(refs, list) and all(isinstance(ref, dict) for ref in refs) else None
    expected = {
        "type": "illustration", "title": item.get("title") or f"Иллюстрация {item.get('pair_id')}",
        "pair_id": item.get("pair_id"), "storyart_project_path": item.get("storyart_project_path"),
        "storyart_style_pack": item.get("storyart_style_pack"),
        "storyart_character_id": item.get("storyart_character_id"),
        "storyart_character_name": item.get("storyart_character_name", ""),
        "generation_id": item.get("approved_generation_id"), "image_path": item.get("approved_image_path"),
        "image_sha256": item.get("image_sha256"), "storyart_status": item.get("approved_status"),
        "visual_qa": "PASS", "canon_qa": "PASS", "author_approval": "GIVEN",
        "author_approval_quote": item.get("author_approval_quote"),
        "candidate_path": f".talewisp/storyart/requests/{item.get('pair_id')}.json",
        "source_refs": expected_refs,
    }
    mismatched = [key for key, value in expected.items() if metadata.get(key) != value]
    actual_links = []
    _prefix, _header, body = _frontmatter(text)
    for line in body.splitlines():
        match = re.fullmatch(r"- ([^:]+): \[\[([^\]]+)\]\]", line)
        if match:
            actual_links.append((match.group(1), _normalize_source_ref(match.group(2))))
    expected_links = [(ref.get("role"), _normalize_source_ref(ref.get("path")))
                      for ref in refs] if isinstance(refs, list) and all(isinstance(ref, dict) for ref in refs) else []
    if actual_links != expected_links:
        mismatched.append("source_links")
    if mismatched:
        return ["published art note no longer matches confirmed candidate fields: " + ", ".join(mismatched)]
    return []


def context(root: Path, args: dict[str, Any]) -> dict[str, Any]:
    rel = args.get("path")
    if not isinstance(rel, str):
        raise StoryArtLinkError("path must be a vault-relative source reference")
    query_file, anchor = _split_reference(rel)
    wanted = _vault_path(root, query_file)
    query_file = Path(query_file).as_posix()
    query_anchor = bool(anchor)
    query_ref = query_file + (f"#{anchor}" if anchor else "")
    query_fragment_exists = not anchor or _fragment_exists(wanted, anchor)
    matches, stale = [], []
    for item in _load_candidates(root):
        if item.get("status") != "APPROVED":
            continue
        refs = item.get("source_refs", [])
        related = [ref for ref in refs if isinstance(ref, dict) and isinstance(ref.get("path"), str)
                   and ref["path"].split("#", 1)[0] == query_file]
        matched = any(ref.get("path") == query_ref for ref in related) if query_anchor else bool(related)
        if not related and not matched:
            continue
        errors = _candidate_errors(root, item)
        view = _authoritative_item(item)
        if errors:
            stale.append({**view, "errors": errors})
        elif matched:
            matches.append(view)
    query_errors = [] if query_fragment_exists else [f"Fragment does not exist in source: {query_ref}"]
    return {"path": query_ref, "exists": wanted.is_file(), "query_valid": query_fragment_exists,
            "query_errors": query_errors, "confirmed_illustrations": matches, "stale_illustrations": stale}


def _load_candidates(root: Path) -> list[dict[str, Any]]:
    folder = _inside(root, root / ".talewisp" / "storyart" / "requests")
    if not folder.is_dir():
        return []
    items = []
    for path in sorted(folder.glob("*.json")):
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise StoryArtLinkError(f"Cannot read StoryArt candidate {path.name}: {exc}") from exc
        if not isinstance(item, dict):
            raise StoryArtLinkError(f"StoryArt candidate {path.name} is not a JSON object")
        items.append(item)
    return items


def _authoritative_item(item: dict[str, Any]) -> dict[str, Any]:
    approved = item.get("status") == "APPROVED"
    result = {"pair_id": item.get("pair_id"), "status": item.get("status"),
              "generation_id": item.get("approved_generation_id") if approved else item.get("generation_id"),
              "image_path": item.get("approved_image_path") if approved else item.get("image_path"),
              "image_sha256": item.get("image_sha256"), "source_refs": item.get("source_refs"),
              "published_path": item.get("published_path")}
    if approved:
        result["staged_generation_id"] = item.get("staged_generation_id", item.get("generation_id"))
        result["staged_image_path"] = item.get("staged_image_path", item.get("image_path"))
    return result


def validate(root: Path, args: dict[str, Any]) -> dict[str, Any]:
    pair = args.get("pair_id")
    if pair:
        items = list_art(root, {"pair_id": pair})["items"]
    else:
        items = list_art(root, {})["items"]
    problems = []
    for item in _load_candidates(root):
        if pair and item.get("pair_id") != pair:
            continue
        errors = _candidate_errors(root, item)
        if errors:
            problems.append({"pair_id": item.get("pair_id"), "errors": errors})
    return {"valid": not problems, "checked": len(items), "problems": problems}


def dispatch(root: Path, action: str, args: dict[str, Any]) -> dict[str, Any]:
    handlers = {"bind-character": bind_character, "resolve-character": resolve_character,
                "stage-art": stage_art, "confirm-art": confirm_art,
                "list-art": list_art, "validate": validate, "context": context}
    if action not in handlers:
        raise StoryArtLinkError(f"Unknown StoryArt link action: {action}")
    try:
        return handlers[action](root.resolve(), args)
    except StoryArtLinkError:
        raise
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise StoryArtLinkError(str(exc)) from exc


def cli() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", required=True)
    parser.add_argument("--request-file", required=True)
    parser.add_argument("action", choices=("bind-character", "resolve-character", "stage-art", "confirm-art", "list-art", "validate", "context"))
    ns = parser.parse_args()
    try:
        request = json.loads(Path(ns.request_file).read_text(encoding="utf-8"))
        result = dispatch(Path(ns.vault), ns.action, request)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, json.JSONDecodeError, StoryArtLinkError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(cli())
