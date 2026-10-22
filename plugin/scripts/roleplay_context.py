"""Source-first bounded context assembly for roleplay readiness.

This module validates declared coverage and deterministic role projections. It
does not prove that a human/model understood every paragraph's meaning.
"""
from __future__ import annotations

import hashlib
import importlib.util
from functools import lru_cache
import json
import re
from pathlib import Path
from typing import Any


class ContextError(ValueError):
    pass


@lru_cache(maxsize=1)
def _motivation_api():
    """Load the sibling module also when this file is loaded by absolute path."""
    spec = importlib.util.spec_from_file_location("talewisp_roleplay_motivation", Path(__file__).with_name("roleplay_motivation.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=1)
def _leadership_api():
    spec = importlib.util.spec_from_file_location("talewisp_roleplay_leadership", Path(__file__).with_name("roleplay_leadership.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=1)
def _scene_design_api():
    spec = importlib.util.spec_from_file_location("talewisp_roleplay_scene_design", Path(__file__).with_name("roleplay_scene_design.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ROLES = {"leader", "hero", "formatter"}
FACT_TARGETS = {"world.rules", "world.limits", "hero.traits", "hero.motives", "hero.goals", "hero.knowledge"}
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
UNIT_ID = re.compile(r"^(?:[A-Z]\d{1,3}-C\d{1,3}-P\d{1,6}|[A-Z]\d{1,3}[A-Z]?-[M]\d{1,6}|D\d{1,3}[A-Z]?-[M]\d{1,6}|P\d{1,6}|M\d{1,6})$")


def _hash(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _json_hash(value: Any) -> str:
    return _hash(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())


canonical_sha256 = _json_hash


def prepare_context(vault_root: Path, request: dict[str, Any]) -> dict[str, Any]:
    """Read every declared line-bounded source unit with stable IDs and hashes."""
    if not isinstance(request, dict) or request.get("context_version") != 2:
        raise ContextError("context_version 2 request is required")
    scope = request.get("read_scope")
    if not isinstance(scope, list) or not scope:
        raise ContextError("read_scope must declare bounded source ranges")
    vault = Path(vault_root).expanduser().resolve()
    sources, seen = [], set()
    for spec in scope:
        if not isinstance(spec, dict):
            raise ContextError("read_scope entries must be objects")
        sid, rel = spec.get("source_id"), spec.get("path")
        if not isinstance(sid, str) or not ID.fullmatch(sid) or sid in seen:
            raise ContextError("source IDs must be unique valid identifiers")
        seen.add(sid)
        if not isinstance(rel, str) or not rel or Path(rel).is_absolute() or ".." in Path(rel).parts:
            raise ContextError(f"Source {sid} path must be vault-relative")
        unresolved = vault / rel
        if any(p.is_symlink() or (hasattr(p, "is_junction") and p.is_junction()) for p in (unresolved, *unresolved.parents) if p != vault.parent):
            raise ContextError(f"Source {sid} cannot use symlinks or junctions")
        path = unresolved.resolve()
        if not path.is_relative_to(vault) or not path.is_file():
            raise ContextError(f"Source {sid} is missing or outside the active vault")
        try:
            raw = path.read_bytes()
            content = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
            lines = content.splitlines(keepends=True)
        except (OSError, UnicodeError) as exc:
            raise ContextError(f"Cannot read source {sid}: {exc}") from exc
        first, last = spec.get("first_id"), spec.get("last_id")
        if not isinstance(first, str) or not isinstance(last, str) or not UNIT_ID.fullmatch(first) or not UNIT_ID.fullmatch(last):
            raise ContextError("Each bounded source needs first_id and last_id")
        markers = []
        for i, line in enumerate(lines):
            match = re.match(r"^\s*(?:#{1,6}\s*)?((?:[A-Z]\d{1,3}-C\d{1,3}-P\d{1,6}|[A-Z]\d{1,3}[A-Z]?-[M]\d{1,6}|D\d{1,3}[A-Z]?-[M]\d{1,6}|P\d{1,6}|M\d{1,6}))(?:\s|[-–—:]|$)", line)
            if match:
                markers.append((i, match.group(1)))
        first_indices = [i for i, (_, uid) in enumerate(markers) if uid == first]
        last_indices = [i for i, (_, uid) in enumerate(markers) if uid == last]
        if len(first_indices) != 1 or len(last_indices) != 1 or last_indices[0] < first_indices[0]:
            raise ContextError(f"Declared source-unit bounds not found for {sid}")
        lo, hi = first_indices[0], last_indices[0]
        selected = markers[lo:hi + 1]
        for (_, a), (_, b) in zip(selected, selected[1:]):
            ma = re.fullmatch(r"([A-Z]\d{1,3}-C\d{1,3}-P)(\d{1,6})", a)
            mb = re.fullmatch(r"([A-Z]\d{1,3}-C\d{1,3}-P)(\d{1,6})", b)
            if ma and mb and ma.group(1) == mb.group(1) and int(mb.group(2)) != int(ma.group(2)) + 1:
                raise ContextError(f"Non-contiguous source unit range: {a} then {b}")
        units = []
        for idx, (line_no, uid) in enumerate(selected):
            stop = selected[idx + 1][0] if idx + 1 < len(selected) else (markers[hi + 1][0] if hi + 1 < len(markers) else len(lines))
            text = "".join(lines[line_no:stop]).strip()
            if not text or any(u["unit_id"] == uid for u in units):
                raise ContextError(f"Empty or duplicate unit ID in {sid}: {uid}")
            units.append({"unit_id": uid, "line": line_no + 1, "text": text, "sha256": _hash(text.encode("utf-8"))})
        sources.append({"source_id": sid, "path": rel, "sha256": _hash(raw), "units": units})
    packet = {"sources": sources}
    return {"source_packet": packet, "source_packet_sha256": _json_hash(packet),
            "expected_unit_ids": [f"{s['source_id']}#{u['unit_id']}" for s in sources for u in s["units"]]}


def build_role_packets(inventory: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Project fact records by declared required role without paraphrasing."""
    result = {role: [] for role in ROLES}
    for fact in inventory.get("facts", []):
        for role in fact.get("required_roles", []):
            if role not in ROLES:
                raise ContextError(f"Unknown role in fact {fact.get('id')}")
        status = fact.get("status")
        audience = set(fact.get("known_to", []))
        for role in ROLES:
            if role == "leader":
                include = True
            else:
                include = status == "active" and "hero" in audience and role in fact.get("required_roles", [])
            if include:
                item = {"fact_id": fact["id"], "claim": fact["claim"], "status": status,
                        "known_to": sorted(audience), "scene_influence": fact.get("scene_influence", ""),
                        "author_constraint_ids": fact.get("author_constraint_ids", [])}
                if role == "leader":
                    item["evidence"] = fact.get("evidence", [])
                result[role].append(item)
    constraints = inventory.get("request", {}).get("author_constraints", [])
    # Exact author wording is included in leader context and only role-relevant
    # constraints are projected to hero/formatter via linked fact IDs.
    result["leader"].append({"author_constraints": constraints})
    for role in ("hero", "formatter"):
        ids = {c for p in result[role] for c in p.get("author_constraint_ids", [])}
        result[role].append({"author_constraints": [c for c in constraints if c.get("id") in ids]})
    return result


_BASIC_MEMORY_FIELDS = {
    "situation": str,
    "experience": list,
    "heard_dialogue": list,
    "observations": list,
    "private_memory": list,
}
_MEMORY_ROLES = {"hero", "leader"}


def _gap_pointer_tokens(pointer: Any, *, gap_id: str) -> list[str]:
    if not isinstance(pointer, str) or not pointer.startswith("/"):
        raise ContextError(f"Context gap {gap_id} binding memory_path must be a JSON pointer")
    raw_tokens = pointer[1:].split("/")
    if not raw_tokens or any(token == "" for token in raw_tokens):
        raise ContextError(f"Context gap {gap_id} binding memory_path has an empty segment")
    tokens = []
    for raw in raw_tokens:
        if re.search(r"~(?![01])", raw):
            raise ContextError(f"Context gap {gap_id} binding memory_path has invalid escaping")
        tokens.append(raw.replace("~1", "/").replace("~0", "~"))
    return tokens


def _validate_gap_bindings(bindings: Any, role_memory: Any, *, gap_id: str, fact: str) -> None:
    if not isinstance(bindings, list) or not bindings:
        raise ContextError(f"Context gap {gap_id} needs at least one role-memory binding")
    seen = set()
    for binding in bindings:
        if not isinstance(binding, dict) or set(binding) != {"role", "memory_path"}:
            raise ContextError(f"Context gap {gap_id} bindings need only role and memory_path")
        role = binding.get("role")
        if not isinstance(role, str) or role not in _MEMORY_ROLES:
            raise ContextError(f"Context gap {gap_id} binding has invalid role")
        pointer = binding.get("memory_path")
        tokens = _gap_pointer_tokens(pointer, gap_id=gap_id)
        key = (role, pointer)
        if key in seen:
            raise ContextError(f"Context gap {gap_id} has duplicate bindings")
        seen.add(key)
        value = role_memory.get(role) if isinstance(role_memory, dict) else None
        for token in tokens:
            if isinstance(value, dict):
                if token not in value:
                    raise ContextError(f"Context gap {gap_id} has dangling role-memory binding")
                value = value[token]
            elif isinstance(value, list):
                if not re.fullmatch(r"0|[1-9][0-9]*", token) or int(token) >= len(value):
                    raise ContextError(f"Context gap {gap_id} has dangling role-memory binding")
                value = value[int(token)]
            else:
                raise ContextError(f"Context gap {gap_id} has dangling role-memory binding")
        if not isinstance(value, str) or value != fact:
            raise ContextError(f"Context gap {gap_id} binding must point to its exact literal positive fact")


def _validate_context_gaps(bundle: dict[str, Any]) -> None:
    # Legacy bundles without this optional host-side record keep their existing behavior.
    if "context_gaps" not in bundle:
        return
    gaps = bundle["context_gaps"]
    if not isinstance(gaps, list):
        raise ContextError("bundle.context_gaps must be a list")
    role_memory = bundle.get("role_memory")
    seen = set()
    unresolved = []
    for gap in gaps:
        if not isinstance(gap, dict):
            raise ContextError("Context gap entries must be objects")
        gap_id, question, status = gap.get("id"), gap.get("question"), gap.get("status")
        if not isinstance(gap_id, str) or not gap_id.strip():
            raise ContextError("Context gap IDs must be nonempty and unique")
        if gap_id in seen:
            raise ContextError("Context gap IDs must be nonempty and unique")
        seen.add(gap_id)
        if not isinstance(question, str) or not question.strip():
            raise ContextError(f"Context gap {gap_id} needs a concrete question")
        if not isinstance(status, str) or status not in {"unresolved", "source_resolved", "branch_resolved", "irrelevant"}:
            raise ContextError(f"Context gap {gap_id} has invalid status")
        common = {"id", "question", "status"}
        if status == "unresolved":
            if set(gap) != common:
                raise ContextError(f"Unresolved context gap {gap_id} cannot carry a resolution")
            unresolved.append(gap_id)
        elif status == "irrelevant":
            if set(gap) != common | {"rationale"} or not isinstance(gap.get("rationale"), str) or not gap["rationale"].strip():
                raise ContextError(f"Irrelevant context gap {gap_id} needs a reason")
        else:
            required = common | {"fact", "rationale", "bindings"}
            if status == "source_resolved":
                required.add("evidence")
            else:
                required.add("authorization")
                if "evidence" in gap:
                    required.add("evidence")
                authorization = gap.get("authorization")
                if (not isinstance(authorization, dict) or set(authorization) != {"type", "exact_text"} or
                        authorization.get("type") != "noncanon_staging" or
                        not isinstance(authorization.get("exact_text"), str) or not authorization["exact_text"].strip()):
                    raise ContextError(f"Branch-resolved context gap {gap_id} needs explicit noncanon staging authorization")
            if set(gap) != required:
                raise ContextError(f"Context gap {gap_id} has incomplete or unknown resolution fields")
            if not isinstance(gap.get("fact"), str) or not gap["fact"].strip():
                raise ContextError(f"Context gap {gap_id} needs a positive fact")
            if not isinstance(gap.get("rationale"), str) or not gap["rationale"].strip():
                raise ContextError(f"Context gap {gap_id} needs a rationale")
            if "evidence" in gap and (not isinstance(gap.get("evidence"), str) or
                                       "#" not in gap["evidence"] or
                                       not all(part.strip() for part in gap["evidence"].split("#", 1))):
                raise ContextError(f"Context gap {gap_id} evidence needs source path and ID")
            _validate_gap_bindings(gap.get("bindings"), role_memory, gap_id=gap_id, fact=gap["fact"])
    if unresolved:
        raise ContextError("Unresolved context gaps block actor dispatch: " + ", ".join(unresolved))


def _validate_memory_record(record: Any, *, label: str) -> None:
    if not isinstance(record, dict):
        raise ContextError(f"{label} must be an object")
    unknown = set(record) - set(_BASIC_MEMORY_FIELDS)
    if unknown:
        raise ContextError(f"Unknown {label} fields: {', '.join(sorted(unknown))}")
    for field, expected in _BASIC_MEMORY_FIELDS.items():
        if field not in record:
            continue
        value = record[field]
        if expected is str:
            if not isinstance(value, str):
                raise ContextError(f"{label}.{field} must be a string")
        elif not isinstance(value, list):
            raise ContextError(f"{label}.{field} must be a list")
        elif field == "heard_dialogue":
            for index, line in enumerate(value):
                line_label = f"{label}.{field}[{index}]"
                if not isinstance(line, dict):
                    raise ContextError(f"{line_label} must be an object")
                if set(line) - {"speaker", "recipient", "text", "manner"}:
                    raise ContextError(f"{line_label} has unknown fields")
                if not all(isinstance(line.get(key), str) for key in ("speaker", "recipient", "text")):
                    raise ContextError(f"{line_label} needs string speaker, recipient, and text")
                if "manner" in line and not isinstance(line["manner"], str):
                    raise ContextError(f"{line_label}.manner must be a string")
        elif not all(isinstance(item, str) for item in value):
            raise ContextError(f"{label}.{field} entries must be strings")


def _validate_turn_intake(bundle: dict[str, Any], hero_action: Any, role: str) -> list[dict[str, Any]]:
    """Validate host-only segmentation against the caller's exact hero turn.

    Literal span coverage detects truncation, staleness, holes, and overlap. It
    cannot establish that the host found or correctly classified every
    semantically material part of the turn.
    """
    has_intake = "turn_intake" in bundle
    if hero_action is None:
        if has_intake:
            raise ContextError("bundle.turn_intake requires the external exact hero_action")
        return []
    if role != "leader":
        raise ContextError("hero_action is accepted only for the leader actor")
    if not isinstance(hero_action, str) or not hero_action.strip():
        raise ContextError("hero_action must be a nonempty exact string")
    intake = bundle.get("turn_intake")
    if not isinstance(intake, dict) or set(intake) != {"hero_action", "units"}:
        raise ContextError("bundle.turn_intake needs exactly hero_action and units")
    if intake.get("hero_action") != hero_action:
        raise ContextError("bundle.turn_intake is stale or does not match the exact hero_action")
    units = intake.get("units")
    if not isinstance(units, list) or not units:
        raise ContextError("bundle.turn_intake.units must be a nonempty list")
    gaps = bundle.get("context_gaps", [])
    gap_ids = {gap["id"] for gap in gaps}
    unit_ids: set[str] = set()
    cursor = 0
    blocked = []
    allowed_fields = {"id", "start", "end", "text", "kind", "disposition", "rationale", "gap_ids"}
    for unit in units:
        if not isinstance(unit, dict) or set(unit) - (allowed_fields | {"addressed_to"}) or not allowed_fields <= set(unit):
            raise ContextError("Each turn intake unit needs id, start, end, text, kind, disposition, rationale, and gap_ids; addressed_to is optional")
        unit_id = unit.get("id")
        if not isinstance(unit_id, str) or not unit_id.strip() or unit_id in unit_ids:
            raise ContextError("Turn intake unit IDs must be nonempty and unique")
        unit_ids.add(unit_id)
        start, end, text = unit.get("start"), unit.get("end"), unit.get("text")
        if (not isinstance(start, int) or isinstance(start, bool) or
                not isinstance(end, int) or isinstance(end, bool) or
                start != cursor or end <= start or end > len(hero_action) or
                not isinstance(text, str) or hero_action[start:end] != text):
            raise ContextError("Turn intake spans must contiguously cover exact hero_action text")
        kind = unit.get("kind")
        if not isinstance(kind, str) or kind not in {"question", "action", "condition", "statement"}:
            raise ContextError(f"Turn intake unit {unit_id} has invalid kind")
        disposition = unit.get("disposition")
        if not isinstance(disposition, str) or disposition not in {"ready", "blocked", "irrelevant"}:
            raise ContextError(f"Turn intake unit {unit_id} has invalid disposition")
        if not isinstance(unit.get("rationale"), str) or not unit["rationale"].strip():
            raise ContextError(f"Turn intake unit {unit_id} needs a rationale")
        references = unit.get("gap_ids")
        if not isinstance(references, list) or not all(isinstance(g, str) for g in references):
            raise ContextError(f"Turn intake unit {unit_id}.gap_ids must be a list of IDs")
        if len(set(references)) != len(references) or any(g not in gap_ids for g in references):
            raise ContextError(f"Turn intake unit {unit_id} has unknown or duplicate context gap references")
        addressed_to = unit.get("addressed_to", [])
        role_memory = bundle.get("role_memory", {})
        leader_memory = role_memory.get("leader", {}) if isinstance(role_memory, dict) else {}
        npc_memories = leader_memory.get("npc_memories", {}) if isinstance(leader_memory, dict) else {}
        if not isinstance(npc_memories, dict):
            raise ContextError("leader memory.npc_memories must be an object")
        if not all(isinstance(name, str) and name for name in npc_memories):
            raise ContextError("leader memory.npc_memories keys must be nonempty strings")
        known_npcs = set(npc_memories)
        if (not isinstance(addressed_to, list) or
                not all(isinstance(name, str) and (name == "self" or name in known_npcs) for name in addressed_to) or
                len(set(addressed_to)) != len(addressed_to)):
            raise ContextError(f"Turn intake unit {unit_id}.addressed_to must contain unique known NPC names or self")
        if disposition == "blocked":
            blocked.append(unit_id)
        cursor = end
    if cursor != len(hero_action):
        raise ContextError("Turn intake spans must contiguously cover exact hero_action text")
    if blocked:
        raise ContextError("Blocked material turn intake units block leader dispatch: " + ", ".join(blocked))
    return units


def validate_leader_response(bundle: dict[str, Any], hero_action: str,
                             response: dict[str, Any]) -> dict[str, Any]:
    """Validate host-private NPC-decision diagnostics against a literal scene.

    This modest structural check cannot prove that rationales are truthful or
    that the host listed every decision; a host must compare the complete scene.
    """
    _validate_context_gaps(bundle)
    _validate_turn_intake(bundle, hero_action, "leader")
    response_fields = {"scene", "hero_position", "hero_activity", "local_result",
                       "private_state", "complete", "npc_decisions"}
    if (not isinstance(response, dict) or
            not {"scene", "npc_decisions"} <= set(response) or
            set(response) - response_fields):
        raise ContextError("Leader response needs scene and npc_decisions and may include only known leader result fields")
    scene, decisions = response.get("scene"), response.get("npc_decisions")
    if not isinstance(scene, str) or not scene.strip() or not isinstance(decisions, list):
        raise ContextError("Leader response needs a nonempty scene and an NPC decision list")
    role_memory = bundle.get("role_memory")
    leader_memory = role_memory.get("leader", {}) if isinstance(role_memory, dict) else {}
    npc_memories = leader_memory.get("npc_memories", {}) if isinstance(leader_memory, dict) else {}
    if not isinstance(npc_memories, dict):
        raise ContextError("leader memory.npc_memories must be an object")
    if not all(isinstance(name, str) and name for name in npc_memories):
        raise ContextError("leader memory.npc_memories keys must be nonempty strings")
    known_npcs = set(npc_memories)
    intake_ids = {unit["id"] for unit in bundle["turn_intake"]["units"]}
    required = {"npc", "decision", "goal", "benefit", "cost", "retained_condition", "action_evidence", "scene_evidence"}
    for index, record in enumerate(decisions):
        if not isinstance(record, dict) or set(record) != required:
            raise ContextError(f"NPC decision {index} has an invalid schema")
        npc = record.get("npc")
        if not isinstance(npc, str) or not npc or npc not in known_npcs:
            raise ContextError(f"NPC decision {index} names an unknown NPC")
        for field in ("decision", "goal", "benefit", "cost"):
            if not isinstance(record.get(field), str) or not record[field].strip():
                raise ContextError(f"NPC decision {index}.{field} must be a nonempty string")
        if not isinstance(record.get("retained_condition"), str):
            raise ContextError(f"NPC decision {index}.retained_condition must be a string (empty when none is claimed)")
        evidence = record.get("scene_evidence")
        if (not isinstance(evidence, list) or not evidence or
                not all(isinstance(item, str) and item.strip() for item in evidence)):
            raise ContextError(f"NPC decision {index}.scene_evidence must contain literal scene text")
        if any(item not in scene for item in evidence):
            raise ContextError(f"NPC decision {index} scene evidence is not present in the literal scene")
        action_evidence = record.get("action_evidence")
        if (not isinstance(action_evidence, list) or not action_evidence or
                not all(isinstance(item, str) and item.strip() for item in action_evidence)):
            raise ContextError(f"NPC decision {index}.action_evidence must contain literal hero_action text")
        for item in action_evidence:
            start = hero_action.find(item)
            if start < 0:
                raise ContextError(f"NPC decision {index} action evidence is not present in the literal hero_action")
            end = start + len(item)
            if not any(unit["start"] < end and unit["end"] > start for unit in bundle["turn_intake"]["units"]):
                raise ContextError(f"NPC decision {index} action evidence has no linked turn intake coverage")
    import copy
    return copy.deepcopy(response)


def _response_context_projection(memory: dict[str, Any], selectors: Any) -> dict[str, Any]:
    """Project selected leader-memory facts without exposing selector metadata."""
    if not isinstance(selectors, list) or not all(isinstance(item, str) for item in selectors):
        raise ContextError("response_context must be a list of leader-memory JSON pointers")
    if len(set(selectors)) != len(selectors):
        raise ContextError("response_context pointers must be unique")

    decoded: list[list[str]] = []
    for pointer in selectors:
        tokens = _gap_pointer_tokens(pointer, gap_id="response_context")
        if tokens[0] not in (set(_BASIC_MEMORY_FIELDS) | {"npc_memories"}):
            raise ContextError("response_context may select only leader memory facts")
        if tokens[0] == "npc_memories" and (len(tokens) < 3 or tokens[1] not in memory.get("npc_memories", {})):
            raise ContextError("response_context must preserve an existing NPC memory owner")
        dialogue_field = 0 if tokens[0] == "heard_dialogue" else (
            2 if tokens[0] == "npc_memories" and len(tokens) > 2 and tokens[2] == "heard_dialogue" else None)
        if dialogue_field is not None and len(tokens) > dialogue_field + 2:
            raise ContextError("response_context must select a heard_dialogue record whole, not a record field")
        decoded.append(tokens)
    for i, tokens in enumerate(decoded):
        if any(tokens != other and tokens == other[:len(tokens)] for j, other in enumerate(decoded) if i != j):
            raise ContextError("response_context cannot select overlapping memory paths")
    list_indexes: dict[tuple[str, ...], list[int]] = {}
    for tokens in decoded:
        if tokens[-1].isdigit():
            parent = tuple(tokens[:-1])
            list_indexes.setdefault(parent, []).append(int(tokens[-1]))
    if any(indexes != sorted(indexes) for indexes in list_indexes.values()):
        raise ContextError("response_context list-item pointers must retain source order")

    import copy
    projection: dict[str, Any] = {}
    for pointer, tokens in zip(selectors, decoded):
        value: Any = memory
        for token in tokens:
            if isinstance(value, dict) and token in value:
                value = value[token]
            elif isinstance(value, list) and token.isdigit() and (token == "0" or not token.startswith("0")):
                index = int(token)
                if index >= len(value):
                    raise ContextError("response_context pointer does not resolve to existing leader memory")
                value = value[index]
            else:
                raise ContextError("response_context pointer does not resolve to existing leader memory")
        is_dialogue_line = (isinstance(value, dict) and
                            set(value) <= {"speaker", "recipient", "text", "manner"} and
                            {"speaker", "recipient", "text"} <= set(value))
        is_dialogue_list = isinstance(value, list) and tokens[-1] == "heard_dialogue"
        if not isinstance(value, str) and not is_dialogue_line and not is_dialogue_list:
            if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
                raise ContextError("response_context may select only text facts or dialogue records")

        selected = copy.deepcopy(value)
        if tokens[-1].isdigit():
            parent_tokens = tokens[:-2]
            field = tokens[-2]
            parent = projection
            for token in parent_tokens:
                parent = parent.setdefault(token, {})
            if field not in parent:
                parent[field] = []
            if not isinstance(parent[field], list):
                raise ContextError("response_context selects overlapping list and item paths")
            parent[field].append(selected)
        else:
            parent = projection
            for token in tokens[:-1]:
                parent = parent.setdefault(token, {})
            parent[tokens[-1]] = selected
    return projection


def build_actor_input(bundle: dict[str, Any], role: str, contract: Any,
                      craft_input: Any = None, *, hero_action: str | None = None,
                      response_context: list[str] | None = None) -> dict[str, Any]:
    """Build a role-only actor prompt payload, excluding host-side audit data.

    The role-memory schema is intentionally narrow. This is a projection
    boundary: diagnostic projections such as ``build_role_packets`` remain
    audit surfaces and must not be passed directly as actor prompts.
    """
    if not isinstance(role, str) or role not in _MEMORY_ROLES:
        raise ContextError(f"Unknown actor role: {role}")
    if response_context is not None and role != "leader":
        raise ContextError("response_context is accepted only for the leader actor")
    if not isinstance(bundle, dict):
        raise ContextError("Actor bundle must be an object")
    _validate_context_gaps(bundle)
    _validate_turn_intake(bundle, hero_action, role)
    role_memory = bundle.get("role_memory")
    if not isinstance(role_memory, dict):
        raise ContextError("bundle.role_memory must be an object")
    unknown_roles = set(role_memory) - _MEMORY_ROLES
    if unknown_roles:
        raise ContextError(f"Unknown role memory entries: {', '.join(sorted(unknown_roles))}")
    memory = role_memory.get(role)
    if not isinstance(memory, dict):
        raise ContextError(f"bundle.role_memory.{role} must be an object")
    allowed = set(_BASIC_MEMORY_FIELDS)
    if role == "leader":
        allowed |= {"npc_memories", "hero_private_memory"}
    unknown = set(memory) - allowed
    if unknown:
        raise ContextError(f"Unknown {role} memory fields: {', '.join(sorted(unknown))}")
    basic = {key: value for key, value in memory.items() if key in _BASIC_MEMORY_FIELDS}
    _validate_memory_record(basic, label=f"{role} memory")
    if role == "leader":
        if "hero_private_memory" in memory and (
                not isinstance(memory["hero_private_memory"], list) or
                not all(isinstance(item, str) for item in memory["hero_private_memory"])):
            raise ContextError("leader memory.hero_private_memory must be a list of strings")
        if "npc_memories" in memory:
            npc_memories = memory["npc_memories"]
            if not isinstance(npc_memories, dict):
                raise ContextError("leader memory.npc_memories must be an object")
            for name, npc_memory in npc_memories.items():
                if not isinstance(name, str) or not name:
                    raise ContextError("leader memory.npc_memories keys must be nonempty strings")
                _validate_memory_record(npc_memory, label=f"leader memory.npc_memories.{name}")
    result = {"role": role, "contract": contract, "memory": memory}
    if response_context is not None:
        result["response_context"] = _response_context_projection(memory, response_context)
    if hero_action is not None:
        result["hero_action"] = hero_action
    if craft_input is not None:
        result["craft_input"] = craft_input
    # Copy the complete output tree so mutations by an actor adapter cannot
    # alter host-owned bundles, contracts, or craft instructions.
    import copy
    return copy.deepcopy(result)


# Live roleplay is deliberately separate from the staged diagnostic API above.
# It provides one host-selected actor at a time; hashes bind packets and
# responses to a specific transcript revision but do not prove literary quality.
_LIVE_ROLES = {"leader", "hero", "npc", "formatter"}
_LIVE_EVENT_KINDS = {"speech", "action"}
_ENACTED_V2 = "enacted-v2"
_LOGICAL_V3 = "logical-v3"


def _live_turn_format(state: dict[str, Any]) -> str:
    return state.get("author_craft", {}).get("turn_format", "live-v1")


def initialize_designed_logical_session(approved_design: dict[str, Any], *, hero_name: str,
                                      author_craft: dict[str, Any], actor_guidance: dict[str, str],
                                      initial_actor: str) -> dict[str, Any]:
    """New-play entry point: private approved design precedes all actor packets."""
    import copy
    try:
        prepared = _scene_design_api().materialize(approved_design)
    except ValueError as exc:
        raise ContextError(str(exc)) from exc
    prepared["bundle"]["approved_scene_design"] = copy.deepcopy(approved_design)
    p = approved_design["input"]
    return initialize_logical_session(prepared["bundle"], hero_name=hero_name,
        actors=p["context"]["actors"], author_craft=author_craft, actor_guidance=actor_guidance,
        initial_actor=initial_actor, session_id=p["session_id"], motivation_frames=prepared["frames"],
        initial_actor_state=prepared["initial_actor_state"], scene_purpose=prepared["purpose"],
        scene_motivation_context={"scope": "PRIVATE DESIGN, not character knowledge or a prescribed result",
                                  "design": copy.deepcopy(approved_design["response"]["design"])})


def initialize_logical_session(bundle: dict[str, Any], *, hero_name: str,
                               actors: dict[str, dict[str, str]], author_craft: dict[str, Any],
                               actor_guidance: dict[str, str], initial_actor: str, session_id: str = "logic1",
                               initial_actor_state: dict[str, dict[str, Any]] | None = None,
                               motivation_frames: dict[str, Any] | None = None,
                               scene_motivation_context: dict[str, Any] | None = None,
                               legacy_motivation: bool = False, leader_scene: bool = True,
                               scene_purpose: dict[str, Any] | None = None) -> dict[str, Any]:
    """Initialize the opt-in logical-v3 turn format on the live-session state API.

    Actor turns contain role-owned decisions and meanings, never finished dialogue.
    ``author_craft`` still carries formatter samples, but actor packets omit them.
    """
    import copy
    motivation = _motivation_api()
    if motivation_frames is None and not legacy_motivation:
        raise ContextError("New logical sessions require source-grounded motivation_frames")
    if motivation_frames is not None:
        try:
            motivation.validate_frames(motivation_frames, actors)
        except motivation.MotivationError as exc:
            raise ContextError(str(exc)) from exc
        if leader_scene:
            try:
                _leadership_api().validate_purpose(scene_purpose)
            except ValueError as exc:
                raise ContextError(str(exc)) from exc
    if scene_motivation_context is not None and not isinstance(scene_motivation_context, dict):
        raise ContextError("scene_motivation_context must be a host-only object")
    if not isinstance(author_craft, dict):
        raise ContextError("logical-v3 needs author craft for actors and formatter")
    if (not isinstance(actor_guidance, dict) or not {"leader", "hero", "npc"} <= set(actor_guidance) or
            any(not isinstance(actor_guidance[role], str) or not actor_guidance[role].strip()
                for role in ("leader", "hero", "npc"))):
        raise ContextError("actor_guidance must separately provide logical behavioral instructions for leader, hero, and NPC")
    craft = copy.deepcopy(author_craft)
    craft["turn_format"] = _LOGICAL_V3
    state = initialize_live_session(bundle, hero_name=hero_name, actors=actors,
        author_craft=craft, initial_actor=initial_actor, session_id=session_id)
    if initial_actor_state is None:
        initial_actor_state = {}
    if not isinstance(initial_actor_state, dict) or set(initial_actor_state) - set(actors):
        raise ContextError("initial_actor_state may contain only declared actor IDs")
    normalized = {}
    for actor_id, value in initial_actor_state.items():
        if not isinstance(value, dict) or set(value) - {"position", "activity"}:
            raise ContextError("Each initial actor state may contain only position and activity")
        if any(not isinstance(item, str) or not item.strip() for item in value.values()):
            raise ContextError("Initial position and activity values must be nonempty strings")
        normalized[actor_id] = copy.deepcopy(value)
    state["logical_initial_actor_state"] = normalized
    state["logical_current_actor_state"] = copy.deepcopy(normalized)
    state["logical_initial_state_sha256"] = _staged_hash(normalized)
    state["logical_current_state_sha256"] = _staged_hash(normalized)
    state["logical_skeleton_sha256"] = _staged_hash(state["transcript"])
    state["logical_actor_guidance"] = copy.deepcopy(actor_guidance)
    if motivation_frames is not None:
        # Static author inputs are fingerprinted with the bundle; character
        # packets expose only their own frame, never another actor's motives.
        state["bundle"]["logical_motivation_frames"] = copy.deepcopy(motivation_frames)
        state["bundle"]["scene_motivation_context"] = copy.deepcopy(scene_motivation_context or {})
        state["logical_motivation_frames"] = copy.deepcopy(motivation_frames)
        state["logical_motivation_history"] = []
        state["logical_motivation_history_sha256"] = _staged_hash([])
    if motivation_frames is not None and leader_scene:
        state["bundle"]["logical_leader_contract"] = "opportunity-v2"
        state["bundle"]["logical_scene_purpose"] = copy.deepcopy(scene_purpose)
        state["logical_scene_history"] = []
        state["logical_scene_history_sha256"] = _staged_hash([])
        state["logical_routing_history"] = []
        state["logical_routing_history_sha256"] = _staged_hash([])
    state["source_fingerprint"] = _staged_hash({"bundle": state["bundle"], "actors": state["actors"],
        "hero_name": state["hero_name"], "author_craft": state["author_craft"],
        "logical_actor_guidance": state["logical_actor_guidance"],
        "logical_initial_actor_state": state["logical_initial_actor_state"]})
    return state


def _logical_assert_state(state: dict[str, Any], *, finished: bool = False) -> None:
    if (not isinstance(state, dict) or state.get("schema") != "roleplay-live-v1" or
            _live_turn_format(state) != _LOGICAL_V3 or state.get("finished") != finished):
        raise ContextError("session is not in the required logical-v3 state")
    if "logical_motivation_frames" in state.get("bundle", {}):
        if (state.get("logical_motivation_frames") != state["bundle"]["logical_motivation_frames"] or
                not isinstance(state.get("logical_motivation_history"), list) or
                _staged_hash(state.get("logical_motivation_history")) != state.get("logical_motivation_history_sha256")):
            raise ContextError("logical motivation context/history changed outside an accepted turn")
    if "logical_leader_contract" in state.get("bundle", {}):
        if (not isinstance(state.get("logical_scene_history"), list) or
                _staged_hash(state["logical_scene_history"]) != state.get("logical_scene_history_sha256")):
            raise ContextError("logical scene history changed outside an accepted turn")
        if (not isinstance(state.get("logical_routing_history"), list) or
                _staged_hash(state["logical_routing_history"]) != state.get("logical_routing_history_sha256")):
            raise ContextError("logical routing history changed outside host control")
    if _staged_hash(state.get("transcript", [])) != state.get("transcript_sha256"):
        raise ContextError("logical transcript changed outside an accepted append or resolution")
    if _staged_hash(state.get("logical_initial_actor_state", {})) != state.get("logical_initial_state_sha256"):
        raise ContextError("logical initial actor state changed after initialization")
    if _staged_hash(state.get("logical_current_actor_state", {})) != state.get("logical_current_state_sha256"):
        raise ContextError("logical current actor state changed outside accepted own-action updates")
    current = _staged_hash({"bundle": state.get("bundle"), "actors": state.get("actors"),
        "hero_name": state.get("hero_name"), "author_craft": state.get("author_craft"),
        "logical_actor_guidance": state.get("logical_actor_guidance"),
        "logical_initial_actor_state": state.get("logical_initial_actor_state")})
    if current != state.get("source_fingerprint"):
        raise ContextError("logical actor guidance changed after initialization")
    if _staged_hash(state.get("transcript", [])) != state.get("logical_skeleton_sha256"):
        raise ContextError("logical skeleton changed outside an accepted append or resolution")


def _logical_actor_memory(state: dict[str, Any], actor_id: str) -> dict[str, Any]:
    import copy
    spec = state["actors"][actor_id]
    memories = state["bundle"]["role_memory"]
    if spec["role"] == "hero":
        own = memories["hero"]
    elif spec["role"] == "npc":
        own = memories["leader"]["npc_memories"][spec["name"]]
    else:
        own = {key: value for key, value in memories["leader"].items() if key != "npc_memories"}
    private_turns = [copy.deepcopy(event["decision"]) for event in state["transcript"]
                     if event.get("actor_id") == actor_id and event.get("kind") == "inner"]
    recorded_sources = {key: {"revision": 0, "sequence": 0}
                        for key in state.get("logical_initial_actor_state", {}).get(actor_id, {})}
    for event in state["transcript"]:
        if event.get("actor_id") == actor_id and event.get("kind") == "action" and event.get("status") == "performed":
            for key in ("position", "activity"):
                if key + "_after" in event:
                    recorded_sources[key] = {"revision": event["revision"], "sequence": event["sequence"]}
    return {"own_memory": copy.deepcopy(own), "own_prior_logical_decisions": private_turns,
            "own_actor_state": {"initial": copy.deepcopy(state.get("logical_initial_actor_state", {}).get(actor_id, {})),
                                "last_recorded": copy.deepcopy(state.get("logical_current_actor_state", {}).get(actor_id, {})),
                                "last_recorded_sources": recorded_sources}}


def _logical_event_projection(state: dict[str, Any], recipient_id: str, event: dict[str, Any]) -> dict[str, Any]:
    """Hide host-side attempt linkage from audiences that did not see the attempt."""
    import copy
    projected = copy.deepcopy(event)
    if event.get("kind") == "resolution" and state["actors"][recipient_id]["role"] != "leader":
        attempt = next((item for item in state["transcript"] if item.get("kind") == "action" and
                        item.get("status") == "attempted" and item.get("attempt_id") == event.get("attempt_id")), None)
        if attempt is not None and recipient_id not in attempt.get("audience", []) and attempt.get("actor_id") != recipient_id:
            projected.pop("attempt_id", None)
    return projected


def _logical_rendering_contract() -> dict[str, Any]:
    """Separate protected meaning from its literary realization; never edit events."""
    return {
        "version": 3,
        "semantic_invariants": {
            "all": "Keep actor ownership, causal and temporal order, knowledge boundaries and stated degree.",
            "inner": "Retain each distinct motive, feeling and qualification, including mixed attitudes. A later recurrence remains true at its source point; unchanged feeling need not receive another label. A new response, changed degree or renewed significant reaction must remain discernible.",
            "communication": "Retain content, recipient, manner, intensity and literal_terms. Manner and intensity constrain how speech reads; they do not prescribe a dialogue tag or require verbatim labels.",
            "action": "Render each chosen action, gesture, attention change and movement with its stated degree. A new act is never removed as redundant state. Attempted is not accomplished.",
            "resolution": "Render every changed effect, its extent and each participant's agency. Explicit source-bound continuity_guards (no damage, no extra action, unchanged properties) constrain truth but need no sentence unless they have a current perceptual or causal function. Unannotated outcomes remain protected in full. Shared content may be expressed once without losing a unique changed effect.",
            "scene_setup": "Host-annotated scene setup establishes available context, not a chosen character action. Its facts remain true as continuity constraints; introduce a fact when its existing function activates. Initial position/activity needed to understand the opening still must be recoverable.",
        },
        "realization": {
            "prose_structure": "Source units protect meaning, not sentence or paragraph boundaries. Compose continuous narrative in the supplied voice, not field-to-sentence transcription.",
            "speech_execution": "Use the utterance's wording, syntax, context and already chosen behavior to convey manner. Connect adjacent same-owner speech and action naturally without changing their order, inventing simultaneity, moving a later proposal backwards, echoing another actor's later initiative, or inventing a gesture.",
            "state_continuity": "Position/activity fields and established unchanged posture or attitude are continuity constraints, not repeated announcements. Keep their consequences true until a source event changes them.",
            "foreground": "Bring setting and material properties into focus when their existing perceptual or causal function activates. Preserve them as constraints even when no separate inventory statement is needed. Concrete selected actions and newly significant reactions remain expressed.",
            "personal_focus": "Use the hero's stated motives, attention and knowledge for personal meaning and practical reasoning. Literary wording may develop that existing meaning, but may not add a motive, decision, memory, bodily reaction or emotional turn.",
            "review": "Assess semantic fidelity and author voice independently. No word quota, tag quota, or automatic deduplication of free text proves either.",
        },
    }


_LOGICAL_WRITER_INSTRUCTION = (
    "Write finished literary prose in the supplied author voice under composition_plan.rendering_contract. "
    "Read source units in exact source_sequence and preserve each semantic act with its owner and time; never move a later proposal or decision backwards. "
    "Build connected perceptual and causal waves from the hero's existing attention and motives, not an inventory or one-paragraph-per-unit template. "
    "Meaning is immutable; its verbal form is free. Manner, intensity and emotional qualification can be clear through wording, context and authorized behavior, "
    "rather than repeated adverbial tags. Preserve mixed attitudes and every distinct emotional change; carry an unchanged posture or feeling without restating its label. "
    "Render all actor-selected gestures, movements, attention changes and degrees. Adjacent speech and behavior can share natural prose while their actual timing remains intact. "
    "Use presentation_role, required_effects and continuity_guards: explicit scene_setup is context, not an actor action; explicit guards remain true without a checklist sentence. "
    "Keep physical properties, entry state and position/activity updates as continuity constraints; entry context is not proof of current state. Activate details at their current perceptual or causal use instead of listing them upfront. "
    "An outcome is lived through its existing cause, effort and perceived consequence, not recited as a technical audit. Shared outcome content may be expressed once without losing any unique consequence or agency. "
    "Keep every communication's meaning, recipient, delivery and literal_terms; do not replace substantive replies with promises. "
    "Private NPC/leader motives and events outside the hero's audience remain inaccessible. The author samples guide voice, not this scene's facts. "
    "Self-check fidelity separately from literary voice, rhythm, dialogue execution and motivated focus, then return only prose. If a required choice is missing, return the exact logical gap instead of inventing it."
)


def _logical_presentation_annotations(events: list[dict[str, Any]], annotations: Any) -> dict[int, dict[str, Any]]:
    """Validate explicit host classification; never guess semantics from free text."""
    import copy
    if not isinstance(annotations, list):
        raise ContextError("presentation annotations must be a list")
    source = {event["sequence"]: event for event in events}
    result = {}
    for item in annotations:
        common = {"source_sequence", "source_event_sha256", "presentation_role"}
        if not isinstance(item, dict) or set(item) not in (common, common | {"parts"}):
            raise ContextError("invalid presentation annotation fields")
        sequence = item["source_sequence"]
        if type(sequence) is not int or sequence not in source or sequence in result:
            raise ContextError("presentation annotation needs one visible source event")
        event = source[sequence]
        if item["source_event_sha256"] != _staged_hash(event):
            raise ContextError("presentation annotation source event changed")
        role = item["presentation_role"]
        if role == "scene_setup":
            if set(item) != common or event["kind"] != "action" or event["speaker_role"] != "leader" or event["status"] != "performed":
                raise ContextError("only performed leader setup can be annotated as scene_setup")
        elif role == "resolved_effect":
            if set(item) != common | {"parts"} or event["kind"] != "resolution" or not isinstance(item["parts"], list) or not item["parts"]:
                raise ContextError("resolved_effect requires resolution parts")
            cursor = 0
            has_effect = False
            for part in item["parts"]:
                if (not isinstance(part, dict) or set(part) != {"start", "end", "use"} or
                        type(part["start"]) is not int or type(part["end"]) is not int or
                        part["start"] != cursor or not cursor < part["end"] <= len(event["resolution"]) or
                        not isinstance(part["use"], str) or part["use"] not in {"changed_effect", "continuity_guard"}):
                    raise ContextError("resolution parts must cover ordered non-overlapping source ranges")
                cursor = part["end"]
                has_effect |= part["use"] == "changed_effect"
            if cursor != len(event["resolution"]) or not has_effect:
                raise ContextError("resolution annotation must cover all text and retain a changed effect")
        else:
            raise ContextError("unknown presentation role")
        result[sequence] = copy.deepcopy(item)
    return result


def _logical_writer_composition_plan(events: list[dict[str, Any]], hero_id: str,
                                    hero_initial_state: dict[str, Any], annotations: list[dict[str, Any]]) -> dict[str, Any]:
    """Make event ownership and sequence explicit without changing actor decisions."""
    import copy
    classified = _logical_presentation_annotations(events, annotations)
    units = []
    hero_state_changes = []
    for event in events:
        sequence = event["sequence"]
        kind = event["kind"]
        unit = {
            "source_sequence": sequence,
            "owner_actor_id": event["actor_id"],
            "owner_name": event["speaker_name"],
            "event_kind": kind,
            "source_event_sha256": _staged_hash(event),
            "source_event": copy.deepcopy(event),
        }
        protected_fields = {
            "inner": ("decision",),
            "communication": ("content", "recipient", "manner", "intensity", "literal_terms"),
            "action": ("action", "status", "attention", "intensity"),
            "resolution": ("outcome", "resolution"),
        }
        unit["semantic_fields"] = [key for key in protected_fields[kind] if key in event]
        unit["continuity_fields"] = [key for key in ("position_after", "activity_after", "audience") if key in event]
        unit["realization_policy"] = kind
        unit["presentation_role"] = kind
        annotation = classified.get(sequence)
        if annotation is not None:
            unit["presentation_role"] = annotation["presentation_role"]
            if annotation["presentation_role"] == "scene_setup":
                unit["semantic_fields"] = []
                unit["continuity_fields"].append("action")
            else:
                unit["semantic_fields"] = ["outcome"]
                unit["required_effects"] = []
                unit["continuity_guards"] = []
                for part in annotation["parts"]:
                    target = "required_effects" if part["use"] == "changed_effect" else "continuity_guards"
                    unit[target].append({**part, "text": event["resolution"][part["start"]:part["end"]]})
        if kind == "action":
            if (event.get("actor_id") == hero_id and event.get("status") == "performed" and
                    any(field + "_after" in event for field in ("position", "activity"))):
                hero_state_changes.append({
                    "source_sequence": sequence,
                    "fields": {field: event[field + "_after"] for field in ("position", "activity")
                               if field + "_after" in event},
                })
        units.append(unit)
    return {
        "ordering": "source_sequence",
        "units": units,
        "rendering_contract": _logical_rendering_contract(),
        "hero_initial_state": copy.deepcopy(hero_initial_state),
        "hero_explicit_state_changes": hero_state_changes,
        "state_semantics": "Initial state and explicit changes are continuity anchors; an unchanged posture need not be restated. Do not infer new state from unstructured text.",
        "composition_freedom": "The prose may combine or separate units in natural paragraphs, while each unit's meaning stays with its owner and source position.",
    }


def build_logical_actor_input(state: dict[str, Any], actor_id: str | None = None) -> dict[str, Any]:
    """Build a logical-v3 packet with separate character and host event views."""
    import copy
    _logical_assert_state(state)
    actor_id = state.get("current_actor") if actor_id is None else actor_id
    if actor_id != state.get("current_actor") or actor_id not in state.get("actors", {}):
        raise ContextError("Only the host-selected current actor can receive a logical packet")
    spec = state["actors"][actor_id]
    craft = state["author_craft"]
    heard = [_logical_event_projection(state, actor_id, event) for event in state["transcript"]
             if actor_id in event.get("audience", []) or event.get("actor_id") == actor_id]
    # The external adjudicator is not a character listener. Preserve the
    # character audience while giving the leader the accepted external history,
    # including covert actions; private inner decisions remain owner-only.
    host_external = ([copy.deepcopy(event) for event in state["transcript"] if event.get("kind") != "inner"]
                     if spec["role"] == "leader" else [])
    resolved_attempts = {event.get("attempt_id") for event in state["transcript"] if event.get("kind") == "resolution"}
    host_pending = ([copy.deepcopy(event) for event in state["transcript"]
                    if event.get("kind") == "action" and event.get("status") == "attempted" and
                    event.get("attempt_id") not in resolved_attempts]
                   if spec["role"] == "leader" else [])
    role_guidance = copy.deepcopy(state["logical_actor_guidance"][spec["role"]])
    packet = {"session_id": state["session_id"], "based_on_revision": state["revision"],
        "source_fingerprint": state["source_fingerprint"], "actor_id": actor_id,
        "role": spec["role"], "actor_name": spec["name"], "hero_name": state["hero_name"],
        "participants": {key: dict(value) for key, value in state["actors"].items()},
        "craft": {"behavioral_guidance": role_guidance},
        "memory": _logical_actor_memory(state, actor_id),
        "heard_events": heard,
        "host_external_events": host_external,
        "host_pending_attempts": host_pending,
        "response_schema": {"turn": [
            {"kind": "inner", "motive": "own private current motive", "emotion": "own private current emotion"},
            {"kind": "action", "status": "performed|attempted", "action": "role-selected behavior/action",
             "audience": ["actor IDs who perceive it"], "attempt_id": "required for attempted", "target": "required for attempted",
             "attention": "optional actor-selected focus", "intensity": "optional actor-selected degree",
             "position_after": "performed only: own resulting position when changed",
             "activity_after": "performed only: own resulting activity when changed"},
            {"kind": "resolution", "attempt_id": "prior accepted unresolved attempt", "outcome": "succeeded|failed|blocked|partial",
             "resolution": "observable external outcome", "audience": ["actors who perceive the outcome"]},
            {"kind": "communication", "recipient": "actor ID or null", "audience": ["listeners"],
             "content": "semantic meaning, not a scripted sentence", "manner": "selected manner", "intensity": "selected degree",
             "literal_terms": ["optional exact critical terms"]}]},
        "instruction": ("Return ordered role-owned logical decisions only. Never write literary dialogue or finished prose. "
            "Specify any gesture, movement, attention shift, or degree of reaction that should appear; the formatter may not invent behavior. "
            "Use inner for this actor's private motive/emotion; only its owner receives it later. Actions distinguish performed from attempted. "
            "Source memory describes entry context and known facts, not a continuously updated scene. own_actor_state.last_recorded contains only the last explicitly recorded position/activity; "
            "it is not a claim of current state. Later accepted actions and resolutions can supersede it even without position_after/activity_after. Follow the ordered accepted events. "
            "Only the external leader receives host_external_events: all accepted non-inner events for adjudication, independent of character audience. "
            "This host view grants no character knowledge and does not make covert events public. "
            "When your performed action changes your position or activity, record that resulting state in position_after/activity_after as applicable. "
            "An attempted action states no outcome and cannot update position/activity. A leader may resolve a host-pending attempt; an NPC may resolve only an attempt it perceived. "
            "Resolution is a separate ordered item and must not rewrite the accepted attempt. Communication gives recipient, audience, meaning, manner, and intensity; exact words belong only in literal_terms when materially critical. "
            "No author prose samples or wording are included in actor packets.")}
    # Advertise only item kinds that this role can actually submit. The common
    # schema otherwise invited the leader to narrate through communication.
    permitted = {"action", "resolution"} if spec["role"] == "leader" else ({"inner", "action", "communication"} if spec["role"] == "hero" else {"inner", "action", "communication", "resolution"})
    packet["response_schema"]["turn"] = [item for item in packet["response_schema"]["turn"] if item["kind"] in permitted]
    packet["instruction"] += ' Return exactly {"packet_binding": <exact copy of INPUT packet_binding>, "response": {"turn": [...]}}. The response_schema lists permitted item shapes, not a required sequence. For the leader, establish external staging with a performed action; never use character communication or inner items.'
    if "logical_motivation_frames" in state["bundle"]:
        motivation = _motivation_api()
        if spec["role"] == "leader":
            packet["author_scene_context"] = copy.deepcopy(state["bundle"]["scene_motivation_context"])
            packet["instruction"] += " author_scene_context is author-only design context, not NPC/hero knowledge or a prescribed result. Never make agreement or friendship obligatory."
        else:
            packet["motivation_context"] = motivation.actor_context(state, actor_id)
            packet["instruction"] += " " + motivation.ACTOR_INSTRUCTION
    if "logical_leader_contract" in state["bundle"] and spec["role"] == "leader":
        frames = state["bundle"]["logical_motivation_frames"]
        packet["scene_task"] = _leadership_api().packet(state, {actor: _motivation_api().current_goal(state, actor) for actor in frames})
    binding = {"session_id": state["session_id"], "source_fingerprint": state["source_fingerprint"],
        "based_on_revision": state["revision"], "prior_transcript_sha256": state["transcript_sha256"],
        "actor_id": actor_id, "packet_fingerprint": _staged_hash(packet)}
    packet["packet_binding"] = binding
    packet["packet_fingerprint"] = binding["packet_fingerprint"]
    return packet


def _validate_logical_turn(state: dict[str, Any], actor_id: str, turn: Any) -> list[dict[str, Any]]:
    if not isinstance(turn, list):
        raise ContextError("logical-v3 response must contain an ordered turn list")
    role = state["actors"][actor_id]["role"]
    normalized = []
    resolved_this_turn = set()
    for index, item in enumerate(turn):
        if not isinstance(item, dict) or not isinstance(item.get("kind"), str):
            raise ContextError(f"Invalid logical turn item at index {index}")
        kind = item["kind"]
        if kind == "inner":
            if role == "leader" or set(item) != {"kind", "motive", "emotion"}:
                raise ContextError("Only hero/NPC owners may return inner motive and emotion")
            if any(not isinstance(item[key], str) or not item[key].strip() for key in ("motive", "emotion")):
                raise ContextError("Logical inner items need nonempty own motive and emotion")
            normalized.append(dict(item))
        elif kind == "action":
            allowed = {"kind", "status", "action", "audience", "attempt_id", "target", "attention", "intensity", "position_after", "activity_after"}
            if set(item) - allowed or not {"kind", "status", "action", "audience"} <= set(item):
                raise ContextError("Logical action has missing or unknown fields")
            if item["status"] not in ("performed", "attempted") or not isinstance(item["action"], str) or not item["action"].strip():
                raise ContextError("Logical action needs performed/attempted status and selected action")
            audience = _live_audience(item["audience"], state["actors"], label="Logical action")
            if item["status"] == "attempted":
                if not isinstance(item.get("attempt_id"), str) or not ID.fullmatch(item["attempt_id"]):
                    raise ContextError("Attempted logical action needs a valid attempt_id")
                if not isinstance(item.get("target"), str) or not item["target"].strip():
                    raise ContextError("Attempted logical action needs an external target")
                if "position_after" in item or "activity_after" in item:
                    raise ContextError("Attempted actions cannot update position or activity before external resolution")
            elif "attempt_id" in item or "target" in item:
                raise ContextError("Performed actions cannot claim an attempted-action resolution")
            for key in ("attention", "intensity", "position_after", "activity_after"):
                if key in item and (not isinstance(item[key], str) or not item[key].strip()):
                    raise ContextError(f"Logical action {key} must be a nonempty string")
            normalized.append({**item, "audience": audience})
        elif kind == "communication":
            allowed = {"kind", "recipient", "audience", "content", "manner", "intensity", "literal_terms"}
            if set(item) - allowed or not {"kind", "recipient", "audience", "content", "manner", "intensity"} <= set(item):
                raise ContextError("Logical communication has missing or unknown fields")
            recipient = item["recipient"]
            if recipient is not None and (not isinstance(recipient, str) or recipient not in state["actors"]):
                raise ContextError("Logical communication recipient must be a declared actor or null")
            for key in ("content", "manner", "intensity"):
                if not isinstance(item[key], str) or not item[key].strip():
                    raise ContextError(f"Logical communication needs nonempty {key}")
            audience = _live_audience(item["audience"], state["actors"], label="Logical communication")
            if recipient is not None and recipient not in audience:
                raise ContextError("Logical communication audience must include its recipient")
            terms = item.get("literal_terms", [])
            if not isinstance(terms, list) or any(not isinstance(term, str) or not term.strip() for term in terms):
                raise ContextError("literal_terms must be a list of nonempty exact critical terms")
            normalized.append({**item, "audience": audience, "literal_terms": list(terms)})
        elif kind == "resolution":
            allowed = {"kind", "attempt_id", "outcome", "resolution", "audience"}
            if set(item) != allowed:
                raise ContextError("Logical resolution needs exactly attempt_id, outcome, resolution, and audience")
            if role not in {"leader", "npc"}:
                raise ContextError("Only the leader or a named NPC may resolve an attempted action")
            if not isinstance(item["attempt_id"], str) or not ID.fullmatch(item["attempt_id"]):
                raise ContextError("Logical resolution needs a valid prior attempt_id")
            if not isinstance(item["outcome"], str) or item["outcome"] not in {"succeeded", "failed", "blocked", "partial"}:
                raise ContextError("Logical resolution outcome must be succeeded, failed, blocked, or partial")
            if not isinstance(item["resolution"], str) or not item["resolution"].strip():
                raise ContextError("Logical resolution needs observable outcome details")
            audience = _live_audience(item["audience"], state["actors"], label="Logical resolution")
            attempts = [event for event in state["transcript"] if event.get("kind") == "action" and
                        event.get("status") == "attempted" and event.get("attempt_id") == item["attempt_id"]]
            if len(attempts) != 1:
                raise ContextError("Logical resolution must reference exactly one previously accepted attempted action")
            if attempts[0].get("actor_id") == actor_id:
                raise ContextError("The initiating actor cannot resolve its own attempted action")
            resolved_before = any(event.get("kind") == "resolution" and event.get("attempt_id") == item["attempt_id"]
                                  for event in state["transcript"])
            if resolved_before or item["attempt_id"] in resolved_this_turn:
                raise ContextError("Logical attempted action already has a resolution")
            if role == "npc" and actor_id not in attempts[0].get("audience", []):
                raise ContextError("NPC can resolve only an attempt it perceived")
            resolved_this_turn.add(item["attempt_id"])
            normalized.append({**item, "audience": audience})
        else:
            raise ContextError(f"Unknown logical turn item kind: {kind}")
    if role == "leader" and any(item["kind"] not in {"action", "resolution"} for item in normalized):
        raise ContextError("The logical leader may return observable action or resolution items only")
    attempt_ids = [item["attempt_id"] for item in normalized if item["kind"] == "action" and item["status"] == "attempted"]
    if len(attempt_ids) != len(set(attempt_ids)):
        raise ContextError("Attempt IDs must be unique within a logical turn")
    existing = {event.get("attempt_id") for event in state["transcript"] if event.get("kind") == "action" and event.get("status") == "attempted"}
    if existing.intersection(attempt_ids):
        raise ContextError("Attempt IDs must be unique across the logical session")
    return normalized


def validate_logical_response(state: dict[str, Any], response_envelope: dict[str, Any]) -> dict[str, Any]:
    """Validate and freeze a logical actor response against its exact packet."""
    _logical_assert_state(state)
    if (not isinstance(response_envelope, dict) or set(response_envelope) != {"packet_binding", "response"} or
            not isinstance(response_envelope.get("response"), dict) or set(response_envelope["response"]) != {"turn"}):
        raise ContextError("logical-v3 response needs packet_binding and response.turn")
    expected = build_logical_actor_input(state)["packet_binding"]
    if response_envelope["packet_binding"] != expected:
        raise ContextError("logical response packet binding is stale or mismatched")
    actor_id = expected["actor_id"]
    turn = _validate_logical_turn(state, actor_id, response_envelope["response"]["turn"])
    frozen = {**expected, "turn": turn}
    return {**frozen, "candidate_sha256": _staged_hash(frozen)}


def logical_continuation_binding(state: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    """Return the binding an independent logical continuation review must cite."""
    _logical_assert_state(state)
    packet = build_logical_actor_input(state)
    candidate_fields = ("session_id", "source_fingerprint", "based_on_revision", "prior_transcript_sha256",
                        "actor_id", "packet_fingerprint")
    if (not isinstance(candidate, dict) or any(candidate.get(key) != packet["packet_binding"].get(key)
                                               for key in candidate_fields) or
            candidate.get("candidate_sha256") != _staged_hash({k: candidate.get(k) for k in (*candidate_fields, "turn")})):
        raise ContextError("logical candidate hash is invalid")
    _validate_logical_turn(state, candidate["actor_id"], candidate.get("turn"))
    return {**packet["packet_binding"], "candidate_sha256": candidate["candidate_sha256"]}


def build_logical_motivation_review_input(state: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    """Host-only evidence packet for a semantic assessment; not an actor input."""
    motivation = _motivation_api()
    binding = logical_continuation_binding(state, candidate)
    actor_id = candidate["actor_id"]
    if actor_id not in state["bundle"].get("logical_motivation_frames", {}):
        raise ContextError("motivation review requires a grounded character session")
    return {"binding": binding, **motivation.review_input(state, actor_id, candidate)}


def accept_logical_response(state: dict[str, Any], candidate: dict[str, Any], *,
                            continuation_review: dict[str, Any], next_actor: str | None) -> dict[str, Any]:
    """Atomically append one independently reviewed logical turn, including resolutions."""
    import copy
    _logical_assert_state(state)
    expected = logical_continuation_binding(state, candidate)
    actor_id = candidate["actor_id"]
    grounded = actor_id in state["bundle"].get("logical_motivation_frames", {})
    review_keys = {"verdict", "issues", "binding"} | ({"motivation"} if grounded else set())
    if (not isinstance(continuation_review, dict) or
            set(continuation_review) != review_keys or
            continuation_review.get("verdict") != "continue" or continuation_review.get("issues") != [] or
            continuation_review.get("binding") != expected):
        raise ContextError("logical continuation review must say continue with no issues and bind this exact candidate")
    motivation_assessment = None
    if grounded:
        motivation = _motivation_api()
        try:
            motivation_assessment = motivation.validate_review(state, actor_id, candidate, continuation_review["motivation"])
        except motivation.MotivationError as exc:
            raise ContextError(str(exc)) from exc
    if "logical_leader_contract" in state["bundle"] and next_actor is None:
        raise ContextError("scene closure requires a separate host consequence review")
    if next_actor is not None and next_actor not in state["actors"]:
        raise ContextError("next_actor must be selected from declared host actors")
    actor_id = candidate["actor_id"]
    spec = state["actors"][actor_id]
    next_state = copy.deepcopy(state.get("logical_current_actor_state", {}))
    accepted_events = []
    for index, decision in enumerate(candidate["turn"]):
        common = {"sequence": len(state["transcript"]) + len(accepted_events) + 1, "revision": state["revision"] + 1,
                  "actor_id": actor_id, "speaker_role": spec["role"], "speaker_name": spec["name"],
                  "item_index": index, "audience": [actor_id] if decision["kind"] == "inner" else list(decision.get("audience", []))}
        if decision["kind"] == "inner":
            event = {**common, "kind": "inner", "decision": copy.deepcopy(decision)}
        else:
            event = {**common, **copy.deepcopy(decision)}
        accepted_events.append(event)
        if decision["kind"] == "action":
            current = next_state.setdefault(actor_id, {})
            if "position_after" in decision:
                current["position"] = decision["position_after"]
            if "activity_after" in decision:
                current["activity"] = decision["activity_after"]
    state["transcript"].extend(accepted_events)
    if motivation_assessment is not None:
        state["logical_motivation_history"].append({"actor_id": actor_id,
            "revision": state["revision"] + 1, "candidate_sha256": candidate["candidate_sha256"],
            "assessment": motivation_assessment})
        state["logical_motivation_history_sha256"] = _staged_hash(state["logical_motivation_history"])
    state["logical_current_actor_state"] = next_state
    state["logical_current_state_sha256"] = _staged_hash(next_state)
    state["revision"] += 1
    state["transcript_sha256"] = _staged_hash(state["transcript"])
    state["logical_skeleton_sha256"] = state["transcript_sha256"]
    state["current_actor"] = next_actor
    state["pending"] = None
    if next_actor is None:
        state["awaiting_finish"] = True
    return {"accepted": True, "revision": state["revision"], "next_actor": next_actor,
            "transcript_sha256": state["transcript_sha256"]}


def logical_scene_control_binding(state: dict[str, Any], *, assessment: dict[str, Any] | None,
                                  next_actor: str | None) -> dict[str, Any]:
    """Bind an explicit private host assessment/route, not a fictional event."""
    _logical_assert_state(state)
    if "logical_leader_contract" not in state["bundle"] or state.get("awaiting_finish"):
        raise ContextError("scene control requires an active opportunity session")
    if next_actor is not None and next_actor not in state["actors"]:
        raise ContextError("next_actor must be declared")
    return {"session_id": state["session_id"], "source_fingerprint": state["source_fingerprint"],
        "revision": state["revision"], "transcript_sha256": state["transcript_sha256"],
        "scene_history_sha256": state["logical_scene_history_sha256"],
        "routing_history_sha256": state["logical_routing_history_sha256"],
        "motivation_history_sha256": state["logical_motivation_history_sha256"],
        "current_actor": state["current_actor"], "next_actor": next_actor,
        "assessment_sha256": _staged_hash(assessment)}


def review_and_route_logical_scene(state: dict[str, Any], *, review: dict[str, Any],
                                   next_actor: str | None) -> dict[str, Any]:
    """Atomically assess accepted events and route; never append a world event."""
    import copy
    if not isinstance(review, dict) or set(review) != {"binding", "assessment"}:
        raise ContextError("scene control needs binding and optional assessment")
    assessment = review["assessment"]
    binding = logical_scene_control_binding(state, assessment=assessment, next_actor=next_actor)
    if review["binding"] != binding:
        raise ContextError("scene control binding is stale or payload/route changed")
    if assessment is not None:
        try:
            assessment = _leadership_api().validate(state, assessment)
        except ValueError as exc:
            raise ContextError(str(exc)) from exc
    if next_actor is None and (assessment is None or assessment["phase"] != "consequence"):
        raise ContextError("scene closure requires an evidenced consequence")
    # All validation is complete before any mutation.
    revision = state["revision"] + 1
    if assessment is not None:
        state["logical_scene_history"].append({"id": "scene:" + str(len(state["logical_scene_history"]) + 1),
            "revision": revision, "assessment": copy.deepcopy(assessment), "binding": copy.deepcopy(binding)})
        state["logical_scene_history_sha256"] = _staged_hash(state["logical_scene_history"])
    state["logical_routing_history"].append({"revision": revision, "binding": copy.deepcopy(binding)})
    state["logical_routing_history_sha256"] = _staged_hash(state["logical_routing_history"])
    state["revision"] = revision
    state["current_actor"] = next_actor
    state["pending"] = None
    state["awaiting_finish"] = next_actor is None
    return {"routed": True, "world_events_added": 0, "revision": revision, "next_actor": next_actor,
            "assessed_phase": assessment["phase"] if assessment else None}


def resolve_logical_attempt(state: dict[str, Any], attempt_id: str, *, outcome: str,
                            resolution: str, audience: list[str], resolver_actor_id: str = "lead") -> dict[str, Any]:
    """Append a host/NPC resolution linked to an accepted attempt without rewriting it."""
    _logical_assert_state(state)
    if not isinstance(attempt_id, str) or not attempt_id.strip():
        raise ContextError("attempt_id is required")
    if not isinstance(outcome, str) or outcome not in {"succeeded", "failed", "blocked", "partial"}:
        raise ContextError("outcome must be succeeded, failed, blocked, or partial")
    if not isinstance(resolution, str) or not resolution.strip():
        raise ContextError("resolution needs observable outcome details")
    if resolver_actor_id not in state["actors"]:
        raise ContextError("resolver_actor_id must be declared")
    audience = _live_audience(audience, state["actors"], label="Attempt resolution")
    attempts = [event for event in state["transcript"] if event.get("kind") == "action" and
                event.get("status") == "attempted" and event.get("attempt_id") == attempt_id]
    if len(attempts) != 1:
        raise ContextError("resolution must reference exactly one accepted attempted action")
    if attempts[0].get("actor_id") == resolver_actor_id:
        raise ContextError("the initiating actor cannot resolve its own attempted action")
    if state["actors"][resolver_actor_id]["role"] not in {"leader", "npc"}:
        raise ContextError("attempt resolution must come from the leader or a named NPC")
    if (state["actors"][resolver_actor_id]["role"] == "npc" and
            resolver_actor_id not in attempts[0].get("audience", [])):
        raise ContextError("NPC can resolve only an attempt it perceived")
    if any(event.get("kind") == "resolution" and event.get("attempt_id") == attempt_id for event in state["transcript"]):
        raise ContextError("attempt already has an appended resolution")
    resolver = state["actors"][resolver_actor_id]
    event = {"sequence": len(state["transcript"]) + 1, "revision": state["revision"] + 1,
        "actor_id": resolver_actor_id, "speaker_role": resolver["role"], "speaker_name": resolver["name"],
        "kind": "resolution", "attempt_id": attempt_id, "outcome": outcome,
        "resolution": resolution, "audience": audience}
    state["transcript"].append(event)
    state["revision"] += 1
    state["transcript_sha256"] = _staged_hash(state["transcript"])
    state["logical_skeleton_sha256"] = state["transcript_sha256"]
    return {"resolved": True, "attempt_id": attempt_id, "outcome": outcome,
            "revision": state["revision"], "transcript_sha256": state["transcript_sha256"]}


def build_logical_formatter_input(state: dict[str, Any], *, presentation_annotations: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Build the writer's POV projection; exclude NPC/leader private decisions."""
    import copy
    _logical_assert_state(state, finished=True)
    hero_id = next(actor_id for actor_id, spec in state["actors"].items() if spec["role"] == "hero")
    visible = []
    for event in state["transcript"]:
        if event.get("kind") == "inner":
            if event.get("actor_id") == hero_id:
                visible.append(_logical_event_projection(state, hero_id, event))
        elif hero_id in event.get("audience", []) or event.get("actor_id") == hero_id:
            visible.append(_logical_event_projection(state, hero_id, event))
    projection_hash = _staged_hash(visible)
    hero_initial_state = copy.deepcopy(state.get("logical_initial_actor_state", {}).get(hero_id, {}))
    annotations = [] if presentation_annotations is None else copy.deepcopy(presentation_annotations)
    composition_plan = _logical_writer_composition_plan(visible, hero_id, hero_initial_state, annotations)
    return {"schema": "logical-v3-writer-input", "session_id": state["session_id"],
        "source_fingerprint": state["source_fingerprint"], "transcript_sha256": state["transcript_sha256"],
        "skeleton_sha256": state["logical_skeleton_sha256"], "projection_sha256": projection_hash,
        "viewpoint": {"actor_id": hero_id, "character": state["hero_name"], "person": "author-selected"},
        "hero_entry_context": copy.deepcopy(state["bundle"]["role_memory"]["hero"]),
        "hero_initial_state": hero_initial_state, "events": visible,
        "composition_plan": composition_plan,
        "presentation_annotations": annotations,
        "composition_plan_sha256": _staged_hash(composition_plan),
        "formatter_guidance": copy.deepcopy(state["author_craft"]["formatter"]),
        "author_samples": copy.deepcopy(state["author_craft"]["author_samples"]),
        "character_voice_evidence": copy.deepcopy(state["author_craft"].get("character_voice_evidence", {})),
        "instruction": _LOGICAL_WRITER_INSTRUCTION}


def build_logical_writer_generation_input(state: dict[str, Any], formatter_input: dict[str, Any], *,
                                          author_directives: list[dict[str, str]] | None = None) -> dict[str, Any]:
    """One clean POV representation for prose; the full formatter stays with audit."""
    import copy
    _logical_assert_state(state, finished=True)
    if not isinstance(formatter_input, dict) or formatter_input != build_logical_formatter_input(
            state, presentation_annotations=formatter_input.get("presentation_annotations", [])):
        raise ContextError("compact writer needs the current full formatter input")
    directives = [] if author_directives is None else copy.deepcopy(author_directives)
    if not isinstance(directives, list) or any(not isinstance(item, dict) or set(item) != {"provenance", "scope", "text"}
            or any(not isinstance(v, str) or not v.strip() for v in item.values()) for item in directives):
        raise ContextError("author directives require literal text, provenance and scope")
    context = {"hero_entry": copy.deepcopy(formatter_input["hero_entry_context"]),
               "hero_initial_state": copy.deepcopy(formatter_input["hero_initial_state"]), "staging": []}
    beats, constraints = [], []
    prior_key = None
    metadata = {"sequence", "revision", "actor_id", "speaker_role", "speaker_name", "kind", "item_index"}
    fields_by_kind = {
        "inner": ("decision",),
        "communication": ("content", "recipient", "manner", "intensity", "literal_terms"),
        "action": ("action", "status", "attention", "intensity", "attempt_id", "target"),
        "resolution": ("outcome", "resolution", "attempt_id"),
    }
    continuity = ("audience", "position_after", "activity_after")
    for unit in formatter_input["composition_plan"]["units"]:
        event = unit["source_event"]
        kind = event["kind"]
        if kind not in fields_by_kind or set(event) - metadata - set(fields_by_kind[kind]) - set(continuity):
            raise ContextError("unknown source field requires an explicit compact projection")
        ref = {"source_sequence": event["sequence"], "source_event_sha256": unit["source_event_sha256"]}
        fixed = {key: copy.deepcopy(event[key]) for key in continuity if key in event}
        if fixed:
            constraints.append({**ref, "fields": fixed})
        if unit["presentation_role"] == "scene_setup":
            context["staging"].append({**ref, "context": event["action"],
                "qualifiers": {key: copy.deepcopy(event[key]) for key in ("attention", "intensity") if key in event}})
            prior_key = None
            continue
        act = {**ref, "kind": kind, "fields": {key: copy.deepcopy(event[key]) for key in fields_by_kind[kind] if key in event}}
        if unit["presentation_role"] == "resolved_effect":
            act["fields"].pop("resolution", None)
            act["fields"]["changed_effects"] = copy.deepcopy(unit["required_effects"])
            if unit["continuity_guards"]:
                constraints.append({**ref, "unchanged_guards": copy.deepcopy(unit["continuity_guards"])})
        key = (event["revision"], event["actor_id"])
        if key != prior_key:
            beats.append({"revision": event["revision"], "owner": {"actor_id": event["actor_id"],
                "name": event["speaker_name"], "role": event["speaker_role"]}, "acts": []})
        beats[-1]["acts"].append(act)
        prior_key = key
    # A reply is the compositional centre; preceding acts keep their actual time and owners.
    # Each act occurs exactly once. Cross-owner lead-ins never become speaker-owned actions.
    interactions, pending = [], []
    for beat in beats:
        for act in beat["acts"]:
            owned = {"revision": beat["revision"], "owner": copy.deepcopy(beat["owner"]), "act": act}
            if act["kind"] == "communication":
                interactions.append({"before_reply": pending, "reply": owned})
                pending = []
            else:
                pending.append(owned)
    anchored_before = set()
    def execution_ref(owned):
        return {key: owned["act"][key] for key in ("source_sequence", "source_event_sha256")}
    for interaction in interactions:
        reply = interaction["reply"]
        anchors = [execution_ref(owned) for owned in interaction["before_reply"]
            if owned["owner"]["actor_id"] == reply["owner"]["actor_id"]
            and owned["revision"] == reply["revision"] and owned["act"]["kind"] == "action"]
        interaction["speech_execution"] = {"before": anchors, "after": []}
        anchored_before.update(a["source_sequence"] for a in anchors)
    for index, interaction in enumerate(interactions):
        following = interactions[index + 1]["before_reply"] if index + 1 < len(interactions) else pending
        if following:
            owned, reply = following[0], interaction["reply"]
            if (owned["owner"]["actor_id"] == reply["owner"]["actor_id"] and owned["revision"] == reply["revision"]
                    and owned["act"]["kind"] == "action" and owned["act"]["source_sequence"] not in anchored_before):
                interaction["speech_execution"]["after"].append(execution_ref(owned))
    packet = {"schema": "logical-v3-writer-input", "presentation_format": "compact-pov-dialogue-v3",
        **{key: formatter_input[key] for key in ("session_id", "source_fingerprint", "transcript_sha256", "skeleton_sha256", "projection_sha256")},
        "audit_input_sha256": _staged_hash(formatter_input),
        "viewpoint": copy.deepcopy(formatter_input["viewpoint"]), "participants": {key: {field: spec[field] for field in ("name", "role")} for key, spec in state["actors"].items()},
        "context": context, "constraints": constraints, "interactions": interactions, "closing_actions": pending,
        "rendering_contract": copy.deepcopy(formatter_input["composition_plan"]["rendering_contract"]),
        "voice": {"guidance": copy.deepcopy(formatter_input["formatter_guidance"]),
            "author_samples": copy.deepcopy(formatter_input["author_samples"]),
            "character_voice_evidence": copy.deepcopy(formatter_input["character_voice_evidence"]),
            "author_directives": directives},
        "instruction": (
            "Напиши законченный литературный фрагмент в голосе автора по voice и образцам. "
            f"Фокальный персонаж: {formatter_input['viewpoint']['character']}. В центре — непрерывное взаимодействие через его восприятие, практические соображения и меняющееся внимание. "
            "Развивай уже заявленный личный смысл; не превращай повтор продолжающегося намерения в новые одинаковые монологи. "
            "speech_execution проверяет принадлежность выбранного исполнения и время: before — до речи, after — после. "
            "Эти ссылки не назначают ремарку и не переносят предшествующие движения в хвост реплики. "
            "Повествование разворачивается в моменте героя: внимание, практический смысл, выбранное действие и следующий ответ образуют связное течение. "
            "Реплика продолжается естественным исполнением и реакцией по авторским опорам; остальные выбранные движения живут в повествовании в своё время. "
            "Покажи каждый акт один раз. Спокойная обычная подача может быть ясна из темпа и контекста; конкретный жест, его особая степень и новая реакция остаются различимыми. "
            "Все исходные акты находятся только в before_reply, reply и closing_actions; ссылки speech_execution не добавляют фактов. "
            "Время, владельцы, жесты, степень, содержание, чувства и границы знаний защищены rendering_contract. "
            "У NPC доступны только наблюдаемые проявления; личное внутреннее значение разворачивается через героя. "
            "Проверь сохранность и литературную связность отдельно. Верни только прозу.")}
    # Put the actual author voice before source phrasing; values occur only once.
    return {key: packet[key] for key in ("schema", "instruction", "voice", *[key for key in packet if key not in {"schema", "instruction", "voice"}])}



def _logical_semantic_slots(packet: dict[str, Any]) -> list[dict[str, Any]]:
    """Locate role-authored text once; IDs, statuses and literal terms stay exact."""
    slots = []
    def add(ref, name, container, key):
        if key in container:
            value = container[key]
            if not isinstance(value, str) or not value.strip():
                raise ContextError("semantic source field must be nonempty text")
            slots.append({"source_sequence": ref["source_sequence"], "source_event_sha256": ref["source_event_sha256"],
                          "field": name, "value": value, "container": container, "key": key})
    for setup in packet["context"]["staging"]:
        add(setup, "action", setup, "context")
        for key in ("attention", "intensity"):
            add(setup, key, setup["qualifiers"], key)
    for constraint in packet["constraints"]:
        for key in ("position_after", "activity_after"):
            add(constraint, key, constraint.get("fields", {}), key)
        for index, guard in enumerate(constraint.get("unchanged_guards", [])):
            add(constraint, f"guard.{index}", guard, "text")
    owned = [o for interaction in packet["interactions"] for o in interaction["before_reply"] + [interaction["reply"]]] + packet["closing_actions"]
    for owner in owned:
        act, fields = owner["act"], owner["act"]["fields"]
        for key in ("action", "attention", "intensity", "content", "manner", "resolution", "target"):
            add(act, key, fields, key)
        for key in ("motive", "emotion"):
            add(act, f"decision.{key}", fields.get("decision", {}), key)
        for index, effect in enumerate(fields.get("changed_effects", [])):
            add(act, f"effect.{index}", effect, "text")
    return sorted(slots, key=lambda item: (item["source_sequence"], item["field"]))


def build_logical_semantic_writer_candidate(state: dict[str, Any], formatter_input: dict[str, Any],
        semantic_manifest: dict[str, Any], *, author_directives: list[dict[str, str]] | None = None) -> dict[str, Any]:
    """Build an unapproved candidate. Ranges prove coverage, independent review proves meaning."""
    import copy
    packet = build_logical_writer_generation_input(state, formatter_input, author_directives=author_directives)
    slots = _logical_semantic_slots(packet)
    if (not isinstance(semantic_manifest, dict) or set(semantic_manifest) != {"schema", "entries"}
            or semantic_manifest["schema"] != "logical-semantic-manifest-v1" or not isinstance(semantic_manifest["entries"], list)):
        raise ContextError("semantic manifest has invalid shape")
    expected = {}
    for slot in slots:
        expected.setdefault(slot["source_sequence"], {})[slot["field"]] = slot
    entries = semantic_manifest["entries"]
    if [e.get("source_sequence") if isinstance(e, dict) else None for e in entries] != list(expected):
        raise ContextError("semantic manifest must cover every source event exactly once in order")
    for entry in entries:
        if set(entry) != {"source_sequence", "source_event_sha256", "fields"} or not isinstance(entry["fields"], list):
            raise ContextError("semantic event has invalid fields")
        targets = expected[entry["source_sequence"]]
        if [f.get("field") if isinstance(f, dict) else None for f in entry["fields"]] != list(targets):
            raise ContextError("semantic manifest must cover every source field exactly once")
        for field in entry["fields"]:
            slot = targets[field["field"]]
            if entry["source_event_sha256"] != slot["source_event_sha256"]:
                raise ContextError("semantic source event changed")
            if set(field) != {"field", "parts"} or not isinstance(field["parts"], list) or not field["parts"]:
                raise ContextError("semantic field requires source parts")
            cursor, components = 0, []
            for part in field["parts"]:
                if (not isinstance(part, dict) or set(part) != {"start", "end", "components"}
                        or type(part["start"]) is not int or type(part["end"]) is not int
                        or part["start"] != cursor or not cursor < part["end"] <= len(slot["value"])
                        or not isinstance(part["components"], list) or not part["components"]):
                    raise ContextError("semantic parts must cover ordered complete source ranges")
                for component in part["components"]:
                    if (not isinstance(component, dict) or set(component) != {"relation", "details"}
                            or not isinstance(component["relation"], str) or not component["relation"].strip()
                            or not isinstance(component["details"], dict) or not component["details"]):
                        raise ContextError("semantic components require a relation and details")
                    # JSON-only data; semantic truth is deliberately not guessed by keyword.
                    try:
                        import json
                        json.dumps(component, ensure_ascii=False, allow_nan=False)
                    except (TypeError, ValueError):
                        raise ContextError("semantic components must be finite JSON data")
                components.extend(copy.deepcopy(part["components"]))
                cursor = part["end"]
            if cursor != len(slot["value"]):
                raise ContextError("semantic parts do not cover full source field")
            slot["container"][slot["key"]] = {"components": components}
    packet["presentation_format"] = "semantic-pov-dialogue-v1"
    packet["semantic_manifest_sha256"] = _staged_hash(semantic_manifest)
    packet["instruction"] += (
        " Текстовые заявки заменены полными смысловыми компонентами. Это факты и условия, не заготовки фраз: "
        "строй литературную сцену по авторским опорам, свободно выбирая синтаксис, фокус и ритм. "
        "Сначала молча собери цельный эпизод из изменений личного смысла, а не абзацы из последовательных полей. "
        "Практическая мысль накапливает наблюдение, оговорку и следствие; прежняя цель продолжает действовать без нового объяснения перед каждым шагом. "
        "Все компоненты выбранного движения или жеста и его степень обязательны; ни один не заменяется общим настроением. "
        "Продолжающееся намерение может проявляться в поступках без новой декларации; новое чувство и решение остаются различимыми. "
        "Служебные ограничения и повторное состояние не требуют отдельной фразы. Исполнение реплики может жить в общем "
        "повествовательном течении; грамматический перечень всех движений после тире не является целью.")
    return packet


def logical_semantic_review_binding(formatter_input: dict[str, Any], semantic_manifest: dict[str, Any],
                                    candidate: dict[str, Any]) -> dict[str, str]:
    return {"audit_input_sha256": _staged_hash(formatter_input), "semantic_manifest_sha256": _staged_hash(semantic_manifest),
            "writer_candidate_sha256": _staged_hash(candidate)}


def build_logical_semantic_writer_input(state: dict[str, Any], formatter_input: dict[str, Any],
        semantic_manifest: dict[str, Any], *, semantic_review: dict[str, Any],
        author_directives: list[dict[str, str]] | None = None) -> dict[str, Any]:
    import copy
    candidate = build_logical_semantic_writer_candidate(state, formatter_input, semantic_manifest, author_directives=author_directives)
    binding = logical_semantic_review_binding(formatter_input, semantic_manifest, candidate)
    if (not isinstance(semantic_review, dict) or set(semantic_review) != {"verdict", "issues", "binding"}
            or semantic_review.get("verdict") != "pass" or semantic_review.get("issues") != [] or semantic_review.get("binding") != binding):
        raise ContextError("independent semantic review must accept the exact source, manifest and candidate")
    return {**candidate, "semantic_review": copy.deepcopy(semantic_review)}


def build_logical_final_review_input(state: dict[str, Any], formatter_input: dict[str, Any], prose: str, *,
                                     generation_input: dict[str, Any] | None = None,
                                     semantic_manifest: dict[str, Any] | None = None) -> dict[str, Any]:
    """Give a separate reviewer the actual prose and full private host skeleton."""
    import copy
    _logical_assert_state(state, finished=True)
    if not isinstance(formatter_input, dict):
        raise ContextError("formatter input must be an object")
    expected_formatter_input = build_logical_formatter_input(state, presentation_annotations=formatter_input.get("presentation_annotations", []))
    if formatter_input != expected_formatter_input:
        raise ContextError("formatter input is stale or not bound to this full logical skeleton")
    if not isinstance(prose, str) or not prose.strip():
        raise ContextError("final review needs actual nonempty prose")
    extra = {}
    if generation_input is not None:
        if not isinstance(generation_input, dict):
            raise ContextError("compact generation input must be an object")
        voice = generation_input.get("voice")
        if not isinstance(voice, dict):
            raise ContextError("compact voice must be an object")
        directives = voice.get("author_directives", [])
        if generation_input.get("presentation_format") == "semantic-pov-dialogue-v1":
            expected = build_logical_semantic_writer_input(state, formatter_input, semantic_manifest,
                semantic_review=generation_input.get("semantic_review"), author_directives=directives)
            extra["semantic_manifest"] = copy.deepcopy(semantic_manifest)
        else:
            if semantic_manifest is not None:
                raise ContextError("semantic manifest requires a semantic generation input")
            expected = build_logical_writer_generation_input(state, formatter_input, author_directives=directives)
        if generation_input != expected:
            raise ContextError("compact generation input lost, reordered or changed protected source data")
        extra.update({"generation_input": copy.deepcopy(generation_input), "compact_input_sha256": _staged_hash(generation_input)})
    return {**extra, "schema": "logical-v3-final-review", "session_id": state["session_id"],
        "source_fingerprint": state["source_fingerprint"], "transcript_sha256": state["transcript_sha256"],
        "skeleton_sha256": state["logical_skeleton_sha256"], "projection_sha256": formatter_input["projection_sha256"],
        "composition_plan": copy.deepcopy(formatter_input["composition_plan"]),
        "presentation_annotations": copy.deepcopy(formatter_input["presentation_annotations"]),
        "composition_plan_sha256": formatter_input["composition_plan_sha256"],
        "writer_input_sha256": _staged_hash(formatter_input),
        "writer_instruction": formatter_input["instruction"],
        "formatter_guidance": copy.deepcopy(formatter_input["formatter_guidance"]),
        "author_samples": copy.deepcopy(formatter_input["author_samples"]),
        "character_voice_evidence": copy.deepcopy(formatter_input["character_voice_evidence"]),
        "prose": prose, "prose_sha256": _staged_hash({"prose": prose}),
        "full_host_skeleton": copy.deepcopy(state["transcript"]),
        "review_dimensions": {"fidelity": "Verify host presentation annotations against full source events: scene_setup must really be setting, and continuity_guards must really preserve unchanged facts, not hide a selected action or changed effect. Structural range/hash validation does not prove this classification. For every composition unit verify exact source order and actor ownership, communication content/recipient/delivery, distinct motives/emotions/qualifications, selected gestures/movements/degrees, changed effects, agency and knowledge boundaries. Reject added, dropped, backfilled, reassigned, or echoed semantic acts. Unchanged context and source-bound guards constrain truth without a mandatory sentence; newly significant reactions and changed degrees remain discernible. Shared wording must retain every unique changed effect.",
                              "style": "Assess author voice against the actual supplied samples and formatter guidance independently of fidelity. Check connected personal focus, accumulating rhythm, dialogue with authorized execution, mechanical manner tags, repeated emotion labels, inventory outcomes, source-field calques and repetitive body-part inventory. Concrete new actor-selected movements must remain present. Do not require one paragraph per unit, a fixed gesture count, or verbatim labels."}}


def validate_logical_prose(state: dict[str, Any], formatter_input: dict[str, Any], prose: str, *,
                           final_review: dict[str, Any], generation_input: dict[str, Any] | None = None,
                                     semantic_manifest: dict[str, Any] | None = None) -> dict[str, Any]:
    """Require separate fidelity/style judgments bound to the actual prose and full skeleton."""
    _logical_assert_state(state, finished=True)
    review_input = build_logical_final_review_input(state, formatter_input, prose, generation_input=generation_input, semantic_manifest=semantic_manifest)
    binding = {key: review_input[key] for key in ("session_id", "source_fingerprint", "transcript_sha256", "skeleton_sha256", "projection_sha256", "composition_plan_sha256", "writer_input_sha256", "prose_sha256")}
    if generation_input is not None:
        binding["compact_input_sha256"] = review_input["compact_input_sha256"]
    if (not isinstance(final_review, dict) or set(final_review) != {"fidelity", "style", "issues", "binding"} or
            final_review.get("binding") != binding or not isinstance(final_review.get("issues"), list) or
            any(not isinstance(issue, str) for issue in final_review["issues"])):
        raise ContextError("final review must bind actual prose and full skeleton, with separate fidelity and style judgments")
    if final_review["fidelity"] not in {"pass", "revise"} or final_review["style"] not in {"pass", "revise"}:
        raise ContextError("final review fidelity and style must each be pass or revise")
    if prose == json.dumps(state["transcript"], ensure_ascii=False, sort_keys=True, separators=(",", ":")):
        raise ContextError("writer output cannot be a serialized copy of the logical skeleton")
    if any(event.get("actor_id") == formatter_input["viewpoint"]["actor_id"] and event.get("kind") == "action" and
           prose == event.get("action") for event in state["transcript"]):
        raise ContextError("writer output cannot be byte-equal to a frozen hero action")
    accepted = final_review["fidelity"] == "pass" and final_review["style"] == "pass" and not final_review["issues"]
    return {"accepted": accepted, "fidelity": final_review["fidelity"], "style": final_review["style"],
        "issues": list(final_review["issues"]), "binding": binding}


def _live_audience(value: Any, actors: dict[str, Any], *, label: str) -> list[str]:
    if (not isinstance(value, list) or not value or
            any(not isinstance(actor_id, str) or actor_id not in actors for actor_id in value) or
            len(set(value)) != len(value)):
        raise ContextError(f"{label} needs a unique nonempty audience of declared actor IDs")
    return list(value)


def _live_assert_source(state: dict[str, Any]) -> None:
    current = _staged_hash({"bundle": state.get("bundle"), "actors": state.get("actors"),
                            "hero_name": state.get("hero_name"), "author_craft": state.get("author_craft")})
    if current != state.get("source_fingerprint"):
        raise ContextError("live source, actor map, or author craft changed after initialization")
    if _staged_hash(state.get("transcript", [])) != state.get("transcript_sha256"):
        raise ContextError("accepted live transcript changed outside the append operation")


def fork_live_owner_context(state: dict[str, Any], *, actor_id: str,
                            extra_experience: list[str], reason: str,
                            session_id: str) -> dict[str, Any]:
    """Create a fresh live branch with appended context for its current NPC owner.

    The accepted transcript is copied verbatim as the played prefix. Only the
    named NPC's own experience is extended; fork provenance stays host-side.
    """
    import copy
    if not isinstance(state, dict) or state.get("schema") != "roleplay-live-v1":
        raise ContextError("owner context fork requires a live-v1 session")
    _live_assert_source(state)
    if (state.get("finished") or state.get("awaiting_finish") or
            state.get("current_actor") is None):
        raise ContextError("owner context fork requires an active, unfinished actor turn")
    if actor_id != state.get("current_actor") or actor_id not in state.get("actors", {}):
        raise ContextError("owner context fork is limited to the current actor")
    actor = state["actors"][actor_id]
    if actor.get("role") != "npc":
        raise ContextError("owner context fork is limited to the current NPC owner")
    if not isinstance(session_id, str) or not ID.fullmatch(session_id) or session_id == state.get("session_id"):
        raise ContextError("owner context fork needs a new valid session ID")
    if not isinstance(reason, str) or not reason.strip():
        raise ContextError("owner context fork needs a nonempty host-side reason")
    if (not isinstance(extra_experience, list) or not extra_experience or
            any(not isinstance(item, str) or not item.strip() for item in extra_experience)):
        raise ContextError("extra_experience must be a nonempty list of nonempty strings")
    role_memory = state.get("bundle", {}).get("role_memory", {})
    npc_memories = role_memory.get("leader", {}).get("npc_memories", {})
    owner = npc_memories.get(actor.get("name")) if isinstance(npc_memories, dict) else None
    if not isinstance(owner, dict):
        raise ContextError("current NPC owner memory is missing")
    old_experience = owner.get("experience", [])
    if not isinstance(old_experience, list) or not all(isinstance(item, str) for item in old_experience):
        raise ContextError("current NPC owner experience must be a list of strings")

    forked = copy.deepcopy(state)
    forked_owner = forked["bundle"]["role_memory"]["leader"]["npc_memories"][actor["name"]]
    forked_owner["experience"] = [*old_experience, *extra_experience]
    forked["session_id"] = session_id
    forked["context_fork"] = {
        "parent_session_id": state["session_id"],
        "parent_source_fingerprint": state["source_fingerprint"],
        "parent_transcript_sha256": state["transcript_sha256"],
        "reason": reason,
    }
    forked["source_fingerprint"] = _staged_hash({
        "bundle": forked["bundle"], "actors": forked["actors"],
        "hero_name": forked["hero_name"], "author_craft": forked["author_craft"]})
    return forked


def initialize_live_session(bundle: dict[str, Any], *, hero_name: str,
                            actors: dict[str, dict[str, str]], author_craft: dict[str, Any],
                            initial_actor: str, session_id: str = "live1",
                            initial_public_events: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Start an append-only sequential roleplay session from host-owned inputs.

    ``actors`` maps host actor IDs to ``{"role": ..., "name": ...}``. The
    author craft object is execution input, not a durable style profile.
    """
    import copy
    if not isinstance(bundle, dict) or not isinstance(bundle.get("role_memory"), dict):
        raise ContextError("live session needs a role_memory bundle")
    if not isinstance(hero_name, str) or not hero_name.strip():
        raise ContextError("live session needs the viewpoint hero name")
    if not isinstance(session_id, str) or not ID.fullmatch(session_id):
        raise ContextError("live session ID is invalid")
    if not isinstance(actors, dict) or not actors or initial_actor not in actors:
        raise ContextError("live session needs declared actors and a valid initial actor")
    normalized = {}
    for actor_id, spec in actors.items():
        if (not isinstance(actor_id, str) or not ID.fullmatch(actor_id) or
                not isinstance(spec, dict) or set(spec) != {"role", "name"} or
                spec.get("role") not in _LIVE_ROLES - {"formatter"} or
                not isinstance(spec.get("name"), str) or not spec["name"].strip()):
            raise ContextError("Each live actor needs a valid host ID, role, and name")
        if spec["role"] == "hero" and spec["name"] != hero_name:
            raise ContextError("The hero actor name must match hero_name")
        normalized[actor_id] = dict(spec)
    if sum(spec["role"] == "hero" for spec in normalized.values()) != 1:
        raise ContextError("A live session needs exactly one hero actor")
    if not isinstance(author_craft, dict) or not {"leader", "hero", "npc", "formatter"} <= set(author_craft):
        raise ContextError("author_craft must provide separate leader, hero, npc, and formatter guidance")
    if not isinstance(author_craft.get("author_samples"), list) or not author_craft["author_samples"]:
        raise ContextError("author_craft must include provenance-tagged author samples")
    for sample in author_craft["author_samples"]:
        if not isinstance(sample, dict) or not isinstance(sample.get("provenance"), str) or not sample["provenance"].strip() or not isinstance(sample.get("text"), str) or not sample["text"].strip():
            raise ContextError("Each author sample needs provenance and literal text")
    role_memory = bundle.get("role_memory", {})
    if not isinstance(role_memory.get("hero"), dict) or not isinstance(role_memory.get("leader"), dict):
        raise ContextError("live session needs hero and leader role memories")
    npc_memories = role_memory["leader"].get("npc_memories", {})
    for actor_id, spec in normalized.items():
        if spec["role"] == "npc" and spec["name"] not in npc_memories:
            raise ContextError(f"NPC actor {actor_id} has no owner-scoped memory")
    initial_public_events = [] if initial_public_events is None else initial_public_events
    if not isinstance(initial_public_events, list):
        raise ContextError("initial_public_events must be a list")
    transcript = []
    for index, event in enumerate(initial_public_events):
        allowed = {"speaker_actor_id", "kind", "text", "recipient", "audience", "source_ref"}
        if (not isinstance(event, dict) or set(event) - allowed or
                not {"speaker_actor_id", "kind", "text", "recipient", "audience"} <= set(event)):
            raise ContextError("Initial public events need speaker, kind, text, recipient, and audience")
        speaker_id = event["speaker_actor_id"]
        if speaker_id not in normalized or event["kind"] not in _LIVE_EVENT_KINDS or not isinstance(event["text"], str) or not event["text"].strip():
            raise ContextError("Initial public event has an invalid speaker, kind, or text")
        if event["recipient"] is not None and event["recipient"] not in normalized:
            raise ContextError("Initial event recipient must be a declared actor ID or null")
        audience = event["audience"]
        if not isinstance(audience, list) or not audience or len(set(audience)) != len(audience) or any(a not in normalized for a in audience):
            raise ContextError("Initial public event needs a unique audience of declared actor IDs")
        source_ref = event.get("source_ref")
        if source_ref is not None and (not isinstance(source_ref, str) or not source_ref.strip()):
            raise ContextError("Initial event source_ref must be a nonempty string when provided")
        speaker = normalized[speaker_id]
        transcript.append({"sequence": index + 1, "revision": 0, "actor_id": speaker_id,
            "speaker_role": speaker["role"], "speaker_name": speaker["name"],
            "event_index": index, "kind": event["kind"], "text": event["text"],
            "recipient": event["recipient"], "audience": list(audience), "source_history": True,
            **({"source_ref": source_ref} if source_ref else {})})
    fingerprint = _staged_hash({"bundle": bundle, "actors": normalized,
                                "hero_name": hero_name, "author_craft": author_craft})
    return {"schema": "roleplay-live-v1", "session_id": session_id,
            "bundle": copy.deepcopy(bundle), "actors": normalized,
            "hero_name": hero_name, "author_craft": copy.deepcopy(author_craft),
            "source_fingerprint": fingerprint, "revision": 0,
            "current_actor": initial_actor, "transcript": transcript,
            "transcript_sha256": _staged_hash(transcript), "pending": None,
            "finished": False}


def _live_actor_memory(state: dict[str, Any], actor_id: str) -> dict[str, Any]:
    import copy
    spec = state["actors"][actor_id]
    memories = state["bundle"]["role_memory"]
    if spec["role"] == "hero":
        # The hero's prior private text is retained only in the hero projection.
        return {"own_memory": copy.deepcopy(memories["hero"]),
                "private_experience": [e.get("private_text", e.get("text")) for e in state["transcript"]
                                      if e.get("actor_id") == actor_id and
                                      (e.get("private_text") or e.get("kind") == "inner")]}
    if spec["role"] == "npc":
        return {"own_memory": copy.deepcopy(memories["leader"]["npc_memories"][spec["name"]])}
    return {"own_memory": {k: copy.deepcopy(v) for k, v in memories["leader"].items() if k != "npc_memories"},
            "host_scene_context": copy.deepcopy(state["bundle"].get("physical_staging", {}))}


def build_live_actor_input(state: dict[str, Any], actor_id: str | None = None) -> dict[str, Any]:
    """Build the sole current actor packet with craft, memory, and heard events."""
    import copy
    if not isinstance(state, dict) or state.get("schema") != "roleplay-live-v1" or state.get("finished"):
        raise ContextError("live session is invalid or already finished")
    _live_assert_source(state)
    actor_id = state.get("current_actor") if actor_id is None else actor_id
    if actor_id != state.get("current_actor") or actor_id not in state.get("actors", {}):
        raise ContextError("Only the host-selected current actor can receive a live packet")
    spec = state["actors"][actor_id]
    role = spec["role"]
    heard = [copy.deepcopy(event) for event in state["transcript"]
             if actor_id in event.get("audience", [])]
    craft = state["author_craft"]
    role_guidance = copy.deepcopy(craft[role])
    if _live_turn_format(state) == _ENACTED_V2 and role == "leader":
        enacted_leader_guidance = (
            "Enacted-v2 leader: present the current situation, the consequences of the actual preceding action, "
            "and any pressure that has changed. Do not invent a threat every turn, and do not choose or speak for the hero. "
            "Return observable action items only.")
        role_guidance = (role_guidance + "\n\n" + enacted_leader_guidance
                         if isinstance(role_guidance, str) else
                         {"author_guidance": role_guidance, "enacted_v2_guidance": enacted_leader_guidance})
    packet = {"session_id": state["session_id"], "based_on_revision": state["revision"],
            "source_fingerprint": state["source_fingerprint"], "actor_id": actor_id,
            "role": role, "actor_name": spec["name"], "hero_name": state["hero_name"],
            "participants": {key: dict(value) for key, value in state["actors"].items()},
            "craft": {"role_guidance": role_guidance,
                      "author_samples": copy.deepcopy(craft["author_samples"]),
                      "character_voice_evidence": copy.deepcopy(craft.get("character_voice_evidence", {}))},
            "memory": _live_actor_memory(state, actor_id), "heard_public_events": heard}
    if _live_turn_format(state) == _ENACTED_V2:
        packet["response_schema"] = {
            "packet_binding": "copy the top-level packet_binding object exactly",
            "response": {"turn": [
                {"kind": "inner", "text": "hero-only text"},
                {"kind": "action", "text": "observable text", "audience": ["actor IDs who perceive it"]},
                {"kind": "speech", "segments": [{"to": "actor ID or null", "text": "spoken words"}],
                 "delivery": "speaker-owned observable attribution/action prose or empty",
                 "audience": ["actor IDs who perceive it"]},
                {"kind": "speech", "pieces": [
                    {"kind": "spoken", "to": "actor ID or null", "text": "spoken fragment"},
                    {"kind": "delivery", "text": "speaker-owned observable manner/action",
                     "form": "attribution"},
                    {"kind": "spoken", "to": "actor ID or null", "text": "continued spoken fragment"}],
                 "audience": ["actor IDs who perceive it"]}]},
            "instruction": ("Return a complete envelope with exactly packet_binding and response. "
                "The response contains only turn. Preserve the ordered sequence of inner, speech, and action items. "
                "Only the hero may return inner; the leader may return action items only. Speech segments may address "
                "different participants within one tactical intent. A speech item may use legacy segments+delivery or "
                "ordered pieces to place observable delivery between spoken fragments. Optional join_previous joins "
                "this item to the prior paragraph in the same turn only. Delivery pieces may set form to attribution "
                "or independent; omission defaults to attribution. Independent preserves a separate sentence boundary. "
                "Do not add mandatory prefixes, word limits, or gesture quotas."),
            "delivery_form": {"field": "speech.pieces[].form", "allowed_values": ["attribution", "independent"],
                              "default": "attribution"}}
    else:
        packet["response_schema"] = {"packet_binding": "copy the top-level packet_binding object exactly",
            "response": {"private_text": "hero only; optional string", "public_events": [
                {"kind": "speech|action", "text": "literal played text", "recipient": "actor ID or null", "audience": ["actor IDs who perceive it"]}]},
            "instruction": "Return the complete envelope with exactly packet_binding and response keys; copy packet_binding literally from this packet."}
    packet_fingerprint = _staged_hash(packet)
    binding = {"session_id": state["session_id"],
               "source_fingerprint": state["source_fingerprint"],
               "based_on_revision": state["revision"],
               "prior_transcript_sha256": state["transcript_sha256"],
               "actor_id": actor_id,
               "packet_fingerprint": packet_fingerprint}
    packet["packet_binding"] = binding
    packet["packet_fingerprint"] = packet_fingerprint
    return packet


def _current_live_packet_binding(state: dict[str, Any]) -> dict[str, Any]:
    packet = build_live_actor_input(state)
    return packet["packet_binding"]


def validate_live_response(state: dict[str, Any], response_envelope: dict[str, Any]) -> dict[str, Any]:
    """Freeze a response envelope bound to the exact actor packet it answers."""
    import copy
    if state.get("schema") != "roleplay-live-v1" or state.get("finished"):
        raise ContextError("live session is invalid or already finished")
    _live_assert_source(state)
    if (not isinstance(response_envelope, dict) or set(response_envelope) != {"packet_binding", "response"} or
            not isinstance(response_envelope.get("packet_binding"), dict)):
        raise ContextError("live response must include the packet_binding envelope returned with its actor input")
    binding = response_envelope["packet_binding"]
    expected_binding = _current_live_packet_binding(state)
    if binding != expected_binding:
        raise ContextError("response packet binding is stale or does not match the current actor input")
    actor_id = binding.get("actor_id")
    based_on_revision = binding.get("based_on_revision")
    response = response_envelope["response"]
    if actor_id != state.get("current_actor") or based_on_revision != state.get("revision"):
        raise ContextError("candidate is stale or not from the host-selected actor")
    if not isinstance(response, dict):
        raise ContextError("live response must be an object")
    spec = state["actors"][actor_id]
    if _live_turn_format(state) == _ENACTED_V2:
        if not isinstance(response, dict) or set(response) != {"turn"} or not isinstance(response["turn"], list):
            raise ContextError("enacted-v2 response must contain only an ordered turn list")
        normalized_turn = []
        for index, item in enumerate(response["turn"]):
            if not isinstance(item, dict):
                raise ContextError("Each enacted turn item must be an object")
            join_key = "join_previous"
            has_join = join_key in item
            if has_join and not isinstance(item[join_key], bool):
                raise ContextError("join_previous must be a boolean")
            if has_join and item[join_key] and index == 0:
                raise ContextError("join_previous needs a previous item in the same turn")
            if set(item) in ({"kind", "text"}, {"kind", "text", join_key}) and item.get("kind") == "inner":
                if spec["role"] != "hero" or not isinstance(item["text"], str) or not item["text"].strip():
                    raise ContextError("Only the hero may provide nonempty inner text")
                normalized = {"kind": "inner", "text": item["text"]}
                if has_join:
                    normalized[join_key] = item[join_key]
                normalized_turn.append(normalized)
            elif set(item) in ({"kind", "text", "audience"}, {"kind", "text", "audience", join_key}) and item.get("kind") == "action":
                if not isinstance(item["text"], str) or not item["text"].strip():
                    raise ContextError("Each enacted action needs observable nonempty text")
                audience = _live_audience(item["audience"], state["actors"], label="Action")
                normalized = {"kind": "action", "text": item["text"], "audience": audience}
                if has_join:
                    normalized[join_key] = item[join_key]
                normalized_turn.append(normalized)
            elif item.get("kind") == "speech" and set(item) in (
                    {"kind", "segments", "delivery", "audience"},
                    {"kind", "segments", "delivery", "audience", join_key}):
                if not isinstance(item["segments"], list) or not item["segments"]:
                    raise ContextError("Enacted speech needs one or more addressed segments")
                segments = []
                for segment in item["segments"]:
                    if (not isinstance(segment, dict) or set(segment) != {"to", "text"} or
                            (segment["to"] is not None and
                             (not isinstance(segment["to"], str) or segment["to"] not in state["actors"])) or
                            not isinstance(segment["text"], str) or not segment["text"].strip()):
                        raise ContextError("Each speech segment needs a declared recipient or null and nonempty spoken text")
                    segments.append({"to": segment["to"], "text": segment["text"]})
                if not isinstance(item["delivery"], str):
                    raise ContextError("Speech delivery must be observable speaker-owned prose or empty")
                audience = _live_audience(item["audience"], state["actors"], label="Speech")
                normalized = {"kind": "speech", "segments": segments,
                              "delivery": item["delivery"], "audience": audience}
                if has_join:
                    normalized[join_key] = item[join_key]
                normalized_turn.append(normalized)
            elif item.get("kind") == "speech" and set(item) in (
                    {"kind", "pieces", "audience"}, {"kind", "pieces", "audience", join_key}):
                if not isinstance(item["pieces"], list) or not item["pieces"]:
                    raise ContextError("Enacted speech needs one or more ordered pieces")
                pieces = []
                previous_piece_kind = None
                for piece in item["pieces"]:
                    if not isinstance(piece, dict) or not isinstance(piece.get("text"), str) or not piece["text"].strip():
                        raise ContextError("Each speech piece needs nonempty literal text")
                    if piece.get("kind") == "spoken" and set(piece) == {"kind", "to", "text"}:
                        if previous_piece_kind == "spoken":
                            raise ContextError("Speech pieces must alternate spoken text and delivery")
                        if piece["to"] is not None and (
                                not isinstance(piece["to"], str) or piece["to"] not in state["actors"]):
                            raise ContextError("Speech piece recipient must be a declared actor ID or null")
                        pieces.append({"kind": "spoken", "to": piece["to"], "text": piece["text"]})
                    elif piece.get("kind") == "delivery" and set(piece) in (
                            {"kind", "text"}, {"kind", "text", "form"}):
                        if previous_piece_kind != "spoken":
                            raise ContextError("Speech delivery must follow spoken text")
                        form = piece.get("form", "attribution")
                        if form not in ("attribution", "independent"):
                            raise ContextError("Speech delivery form must be attribution or independent")
                        normalized_piece = {"kind": "delivery", "text": piece["text"]}
                        if "form" in piece:
                            normalized_piece["form"] = form
                        pieces.append(normalized_piece)
                    else:
                        raise ContextError("Speech pieces must be spoken pieces with recipient or speaker-owned delivery pieces")
                    previous_piece_kind = piece["kind"]
                if pieces[0]["kind"] != "spoken" or pieces[-1]["kind"] != "spoken":
                    raise ContextError("Speech pieces must start and end with spoken text")
                audience = _live_audience(item["audience"], state["actors"], label="Speech")
                normalized = {"kind": "speech", "pieces": pieces, "audience": audience}
                if has_join:
                    normalized[join_key] = item[join_key]
                normalized_turn.append(normalized)
            else:
                raise ContextError(f"Invalid enacted turn item at index {index}")
        if spec["role"] != "hero" and any(item["kind"] == "inner" for item in normalized_turn):
            raise ContextError("Only the hero may return inner text")
        if spec["role"] == "leader" and any(item["kind"] != "action" for item in normalized_turn):
            raise ContextError("The leader may return action items only")
        frozen = {"session_id": binding["session_id"],
                  "source_fingerprint": binding["source_fingerprint"],
                  "based_on_revision": based_on_revision,
                  "prior_transcript_sha256": binding["prior_transcript_sha256"],
                  "packet_fingerprint": binding["packet_fingerprint"],
                  "actor_id": actor_id, "turn": normalized_turn}
        return {**frozen, "candidate_sha256": _staged_hash(frozen)}
    if set(response) - {"private_text", "public_events"} or "public_events" not in response:
        raise ContextError("live response accepts only private_text and public_events")
    private_text = response.get("private_text", "")
    if not isinstance(private_text, str) or (private_text and spec["role"] != "hero"):
        raise ContextError("Only the hero may provide private experience text")
    events = response["public_events"]
    if not isinstance(events, list) or any(not isinstance(event, dict) or set(event) != {"kind", "text", "recipient", "audience"} for event in events):
        raise ContextError("public_events must use the exact live event schema")
    normalized_events = []
    for event in events:
        if event["kind"] not in _LIVE_EVENT_KINDS or not isinstance(event["text"], str) or not event["text"].strip():
            raise ContextError("Each public event needs kind speech/action and nonempty literal text")
        if event["recipient"] is not None and event["recipient"] not in state["actors"]:
            raise ContextError("Event recipient must be a declared actor ID or null")
        audience = event["audience"]
        if not isinstance(audience, list) or not audience or len(set(audience)) != len(audience) or any(a not in state["actors"] for a in audience):
            raise ContextError("Each public event needs a unique audience of declared actor IDs")
        normalized_events.append({"kind": event["kind"], "text": event["text"],
                                  "recipient": event["recipient"], "audience": list(audience)})
    frozen = {"session_id": binding["session_id"],
              "source_fingerprint": binding["source_fingerprint"],
              "based_on_revision": based_on_revision,
              "prior_transcript_sha256": binding["prior_transcript_sha256"],
              "packet_fingerprint": binding["packet_fingerprint"],
              "actor_id": actor_id,
              "private_text": private_text, "public_events": normalized_events}
    return {**frozen, "candidate_sha256": _staged_hash(frozen)}


def accept_live_response(state: dict[str, Any], candidate: dict[str, Any], *,
                         semantic_review: dict[str, Any], next_actor: str | None) -> dict[str, Any]:
    """Append one reviewed response and advance to the host-selected actor."""
    import copy
    if state.get("schema") != "roleplay-live-v1" or state.get("finished"):
        raise ContextError("live session is invalid or already finished")
    _live_assert_source(state)
    if (not isinstance(candidate, dict) or candidate.get("actor_id") != state.get("current_actor") or
            candidate.get("based_on_revision") != state.get("revision")):
        raise ContextError("candidate is stale or not from the current actor/revision")
    binding = _current_live_packet_binding(state)
    candidate_binding = {key: candidate.get(key) for key in binding}
    if candidate_binding != binding:
        raise ContextError("candidate packet binding does not match the current actor input")
    if _live_turn_format(state) == _ENACTED_V2:
        checked = validate_live_response(state, {"packet_binding": candidate_binding,
            "response": {"turn": candidate.get("turn")}})
    else:
        checked = validate_live_response(state, {"packet_binding": candidate_binding,
            "response": {"private_text": candidate.get("private_text", ""),
                         "public_events": candidate.get("public_events")}})
    if checked.get("candidate_sha256") != candidate.get("candidate_sha256"):
        raise ContextError("candidate does not match the validated response schema")
    if _live_turn_format(state) == _ENACTED_V2:
        frozen = {k: candidate[k] for k in (
            "session_id", "source_fingerprint", "based_on_revision", "prior_transcript_sha256",
            "packet_fingerprint", "actor_id", "turn")}
    else:
        frozen = {k: candidate[k] for k in (
            "session_id", "source_fingerprint", "based_on_revision", "prior_transcript_sha256",
            "packet_fingerprint", "actor_id", "private_text", "public_events")}
    digest = _staged_hash(frozen)
    if candidate.get("candidate_sha256") != digest:
        raise ContextError("candidate content hash does not match")
    if _live_turn_format(state) == _ENACTED_V2:
        expected_review_binding = {**binding, "candidate_sha256": digest}
        if (not isinstance(semantic_review, dict) or set(semantic_review) != {"verdict", "issues", "binding"} or
                semantic_review.get("verdict") != "pass" or semantic_review.get("issues") != [] or
                semantic_review.get("binding") != expected_review_binding):
            raise ContextError("enacted-v2 requires a pass review with no issues and an exact candidate binding")
    elif (not isinstance(semantic_review, dict) or semantic_review.get("accepted") is not True or
            semantic_review.get("candidate_sha256") != digest or
            semantic_review.get("session_id") != state["session_id"] or
            semantic_review.get("source_fingerprint") != state["source_fingerprint"] or
            semantic_review.get("based_on_revision") != state["revision"] or
            semantic_review.get("actor_id") != candidate["actor_id"] or
            semantic_review.get("prior_transcript_sha256") != state["transcript_sha256"] or
            semantic_review.get("packet_fingerprint") != binding["packet_fingerprint"]):
        raise ContextError("host semantic review must accept this exact candidate and revision")
    if next_actor is not None and next_actor not in state["actors"]:
        raise ContextError("next_actor must be selected from declared host actors")
    actor_id = candidate["actor_id"]
    actor = state["actors"][actor_id]
    if _live_turn_format(state) == _ENACTED_V2:
        for index, item in enumerate(candidate["turn"]):
            common = {"sequence": len(state["transcript"]) + 1,
                      "revision": state["revision"] + 1, "actor_id": actor_id,
                      "speaker_role": actor["role"], "speaker_name": actor["name"],
                      "turn_item_index": index}
            if item["kind"] == "inner":
                event = {**common, "kind": "inner", "text": item["text"], "audience": [actor_id]}
                if "join_previous" in item:
                    event["join_previous"] = item["join_previous"]
                state["transcript"].append(event)
            elif item["kind"] == "action":
                event = {**common, "kind": "action", "text": item["text"],
                         "audience": list(item["audience"])}
                if "join_previous" in item:
                    event["join_previous"] = item["join_previous"]
                state["transcript"].append(event)
            else:
                event = {**common, "kind": "speech", "audience": list(item["audience"])}
                if "pieces" in item:
                    event["pieces"] = copy.deepcopy(item["pieces"])
                else:
                    event["segments"] = copy.deepcopy(item["segments"])
                    event["delivery"] = item["delivery"]
                if "join_previous" in item:
                    event["join_previous"] = item["join_previous"]
                state["transcript"].append(event)
    else:
        if candidate.get("private_text"):
            state.setdefault("private_experience", []).append({"actor_id": actor_id,
                "revision": state["revision"] + 1, "text": candidate["private_text"]})
            state["transcript"].append({"sequence": len(state["transcript"]) + 1,
                "revision": state["revision"] + 1, "actor_id": actor_id,
                "speaker_role": "hero", "speaker_name": actor["name"],
                "private_text": candidate["private_text"], "audience": [actor_id]})
        for index, event in enumerate(candidate["public_events"]):
            state["transcript"].append({"sequence": len(state["transcript"]) + 1,
                "revision": state["revision"] + 1, "actor_id": actor_id,
                "speaker_role": actor["role"], "speaker_name": actor["name"],
                "event_index": index, **copy.deepcopy(event)})
    state["revision"] += 1
    state["transcript_sha256"] = _staged_hash(state["transcript"])
    state["current_actor"] = next_actor
    state["pending"] = None
    if next_actor is None:
        state["awaiting_finish"] = True
    return {"accepted": True, "revision": state["revision"], "next_actor": next_actor,
            "transcript_sha256": _staged_hash(state["transcript"])}


def finish_live_session(state: dict[str, Any]) -> dict[str, Any]:
    """Close a sequential session after the host explicitly chooses no next actor."""
    if (not isinstance(state, dict) or state.get("schema") != "roleplay-live-v1" or
            state.get("finished") or not state.get("awaiting_finish") or state.get("current_actor") is not None):
        raise ContextError("live session can finish only after an accepted response with no next actor")
    if _live_turn_format(state) == _LOGICAL_V3:
        _logical_assert_state(state)
    state["finished"] = True
    state["awaiting_finish"] = False
    state["final_transcript_sha256"] = _staged_hash(state["transcript"])
    return {"finished": True, "revision": state["revision"],
            "transcript_sha256": state["final_transcript_sha256"]}


def render_enacted_scene(state: dict[str, Any], *, include_role_labels: bool = False,
                         hero_name: str | None = None) -> tuple[str, list[dict[str, Any]]]:
    """Render an enacted turn deterministically and return exact ordered item slices.

    Input may be ``{"turn": [...]}`` in the enacted-v2 response shape, or a
    finished live state. This is a literal compositor: it does not invent prose.
    """
    actors = state.get("actors", {}) if isinstance(state, dict) else {}
    if isinstance(state, dict) and isinstance(state.get("turn"), list):
        items = state["turn"]
    elif isinstance(state, dict) and isinstance(state.get("transcript"), list):
        items = []
        for event in state["transcript"]:
            if event.get("source_history"):
                continue
            if event.get("kind") == "inner":
                inner = {"kind": "inner", "text": event["text"], "speaker_name": event.get("speaker_name"),
                         "speaker_role": event.get("speaker_role"), "revision": event.get("revision"),
                         "turn_item_index": event.get("turn_item_index")}
                if "join_previous" in event:
                    inner["join_previous"] = event["join_previous"]
                items.append(inner)
            elif event.get("kind") == "action":
                action = {"kind": "action", "text": event["text"], "audience": event.get("audience", []),
                          "speaker_name": event.get("speaker_name"), "speaker_role": event.get("speaker_role"),
                          "revision": event.get("revision"), "turn_item_index": event.get("turn_item_index")}
                if "join_previous" in event:
                    action["join_previous"] = event["join_previous"]
                items.append(action)
            elif event.get("kind") == "speech":
                speech = {"kind": "speech", "audience": event.get("audience", []),
                          "speaker_name": event.get("speaker_name"),
                          "speaker_role": event.get("speaker_role"),
                          "revision": event.get("revision"),
                          "turn_item_index": event.get("turn_item_index")}
                if "pieces" in event:
                    speech["pieces"] = event["pieces"]
                else:
                    speech["segments"] = event["segments"]
                    speech["delivery"] = event.get("delivery", "")
                if "join_previous" in event:
                    speech["join_previous"] = event["join_previous"]
                items.append(speech)
    else:
        raise ContextError("enacted renderer needs an ordered turn or live transcript")
    rendered_items: list[tuple[str, int, str, bool, Any, Any, Any]] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ContextError("Each enacted render item must be an object")
        label = ""
        if include_role_labels:
            name = item.get("speaker_name") or "Участник"
            role = item.get("speaker_role")
            label = ("ГЕРОЙ" if role == "hero" else "ВЕДУЩИЙ" if role == "leader" else "NPC") + f" ({name}): "
        if item.get("kind") == "inner" and isinstance(item.get("text"), str):
            text, kind = item["text"], "inner"
        elif item.get("kind") == "action" and isinstance(item.get("text"), str):
            text, kind = item["text"], "action"
        elif item.get("kind") == "speech":
            if "pieces" in item:
                pieces = item.get("pieces")
                if not isinstance(pieces, list) or not pieces:
                    raise ContextError("Enacted render speech needs ordered pieces")
                rendered_pieces: list[str] = []
                previous_kind = None
                for piece in pieces:
                    if not isinstance(piece, dict) or not isinstance(piece.get("text"), str) or not piece["text"].strip():
                        raise ContextError("Enacted render speech pieces need nonempty literal text")
                    piece_kind = piece.get("kind")
                    if piece_kind == "spoken" and set(piece) == {"kind", "to", "text"}:
                        if previous_kind == "spoken":
                            rendered_pieces.append(" " + piece["text"])
                        else:
                            if previous_kind == "delivery":
                                previous = rendered_pieces[-1]
                                if not previous.endswith((".", "?", "!", "…", ";", ",")):
                                    rendered_pieces[-1] = previous + "."
                            rendered_pieces.append(("— " if previous_kind is None else " — ") + piece["text"])
                    elif piece_kind == "delivery" and set(piece) == {"kind", "text"}:
                        if previous_kind != "spoken":
                            raise ContextError("Enacted render delivery must follow spoken text")
                        form = piece.get("form", "attribution")
                        if form not in ("attribution", "independent"):
                            raise ContextError("Enacted render delivery form must be attribution or independent")
                        if form == "attribution":
                            previous = rendered_pieces[-1]
                            if previous.endswith("."):
                                rendered_pieces[-1] = previous[:-1] + ","
                            elif not previous.endswith((",", "?", "!", "…")):
                                rendered_pieces[-1] = previous + ","
                        rendered_pieces.append(" — " + piece["text"])
                    elif piece_kind == "delivery" and set(piece) == {"kind", "text", "form"}:
                        if previous_kind != "spoken":
                            raise ContextError("Enacted render delivery must follow spoken text")
                        if piece["form"] not in ("attribution", "independent"):
                            raise ContextError("Enacted render delivery form must be attribution or independent")
                        if piece["form"] == "attribution":
                            previous = rendered_pieces[-1]
                            if previous.endswith("."):
                                rendered_pieces[-1] = previous[:-1] + ","
                            elif not previous.endswith((",", "?", "!", "…")):
                                rendered_pieces[-1] = previous + ","
                        rendered_pieces.append(" — " + piece["text"])
                    else:
                        raise ContextError("Enacted render speech piece has an invalid shape")
                    previous_kind = piece_kind
                if previous_kind != "spoken":
                    raise ContextError("Enacted render speech pieces must end with spoken text")
                text = "".join(rendered_pieces)
            else:
                segments = item.get("segments")
                if not isinstance(segments, list) or not segments or any(
                        not isinstance(segment, dict) or not isinstance(segment.get("text"), str)
                        for segment in segments):
                    raise ContextError("Enacted render speech needs ordered literal segments")
                spoken = " ".join(segment["text"] for segment in segments)
                delivery = item.get("delivery", "")
                if not isinstance(delivery, str):
                    raise ContextError("Enacted render delivery must be text")
                if delivery:
                    delivery = delivery.rstrip()
                    if delivery and not delivery.endswith((".", "?", "!", "…")):
                        delivery += "."
                    if spoken.endswith("."):
                        spoken = spoken[:-1] + ","
                        text = f"— {spoken} — {delivery}"
                    elif spoken.endswith(("?", "!", "…")):
                        text = f"— {spoken} — {delivery}"
                    else:
                        text = f"— {spoken}, — {delivery}"
                else:
                    text = f"— {spoken}"
            kind = "speech"
        else:
            raise ContextError(f"Unsupported enacted render item at index {index}")
        if not text.strip():
            raise ContextError("Enacted render item text must be nonempty")
        join_previous = item.get("join_previous", False)
        if not isinstance(join_previous, bool):
            raise ContextError("Enacted render join_previous must be a boolean")
        rendered_items.append((label + text, index, kind, join_previous,
                               item.get("revision"), item.get("turn_item_index"), item.get("speaker_name")))
    parts: list[str] = []
    slices: list[dict[str, Any]] = []
    offset = 0
    previous_join_group = None
    for index, (chunk, item_index, kind, join_previous, revision, turn_item_index, speaker_name) in enumerate(rendered_items):
        if join_previous:
            if index == 0:
                raise ContextError("join_previous needs a previous item in the same turn")
            previous_revision, previous_turn_item_index, previous_speaker_name = previous_join_group
            if revision is not None or previous_revision is not None:
                if (revision is None or previous_revision != revision or
                        turn_item_index is None or previous_turn_item_index is None or
                        turn_item_index != previous_turn_item_index + 1 or speaker_name != previous_speaker_name):
                    raise ContextError("join_previous may join items only within the same turn")
            parts.append(" ")
            offset += 1
        elif index:
            parts.append("\n\n")
            offset += 2
        parts.append(chunk)
        slices.append({"offset": offset, "text": chunk, "item": item_index, "kind": kind})
        offset += len(chunk)
        previous_join_group = (revision, turn_item_index, speaker_name)
    return "".join(parts), slices


def build_live_formatter_input(state: dict[str, Any]) -> dict[str, Any]:
    """Prepare the complete accepted skeleton without NPC private memories."""
    import copy
    if not state.get("finished"):
        raise ContextError("formatter input requires an explicitly finished live session")
    _live_assert_source(state)
    craft = state["author_craft"]
    # Prior source-backed dialogue informs the actors who heard it, but is not
    # part of the newly played prose the formatter is asked to render.
    public = [copy.deepcopy(event) for event in state["transcript"]
              if "private_text" not in event and not event.get("source_history")]
    hero_private = [copy.deepcopy(event) for event in state["transcript"]
                    if (event.get("private_text") or event.get("kind") == "inner") and event.get("speaker_role") == "hero"]
    if _live_turn_format(state) == _ENACTED_V2:
        turn = [{"kind": "inner", "text": event["text"], "speaker_name": event["speaker_name"],
                 "speaker_role": event["speaker_role"], "revision": event["revision"],
                 "turn_item_index": event["turn_item_index"],
                 **({"join_previous": event["join_previous"]} if "join_previous" in event else {})}
                if event.get("kind") == "inner" else
                ({"kind": "action", "text": event["text"], "audience": copy.deepcopy(event["audience"]),
                  "speaker_name": event["speaker_name"], "speaker_role": event["speaker_role"],
                  "revision": event["revision"], "turn_item_index": event["turn_item_index"],
                  **({"join_previous": event["join_previous"]} if "join_previous" in event else {})}
                 if event.get("kind") == "action" else
                 ({"kind": "speech", "pieces": copy.deepcopy(event["pieces"]),
                   "audience": copy.deepcopy(event["audience"]),
                   "speaker_name": event["speaker_name"], "speaker_role": event["speaker_role"],
                   "revision": event["revision"], "turn_item_index": event["turn_item_index"],
                   **({"join_previous": event["join_previous"]} if "join_previous" in event else {})}
                  if "pieces" in event else
                  {"kind": "speech", "segments": copy.deepcopy(event["segments"]),
                   "delivery": event.get("delivery", ""), "audience": copy.deepcopy(event["audience"]),
                   "speaker_name": event["speaker_name"], "speaker_role": event["speaker_role"],
                   "revision": event["revision"], "turn_item_index": event["turn_item_index"],
                   **({"join_previous": event["join_previous"]} if "join_previous" in event else {})}))
                for event in public]
        rendered, slices = render_enacted_scene({"turn": turn}, include_role_labels=False)
        return {"session_id": state["session_id"], "source_fingerprint": state["source_fingerprint"],
                "transcript_sha256": state["final_transcript_sha256"],
                "complete_accepted_transcript": public, "hero_private_experience": hero_private,
                "hero_name": state["hero_name"], "formatter_craft": copy.deepcopy(craft["formatter"]),
                "author_samples": copy.deepcopy(craft["author_samples"]),
                "character_voice_evidence": copy.deepcopy(craft.get("character_voice_evidence", {})),
                "character_relationship_evidence": copy.deepcopy(state["bundle"].get("relationship_samples", [])),
                "rendered_scene": rendered, "ordered_slices": slices,
                "instruction": ("This enacted-v2 turn already contains its played prose and speech delivery in deterministic order. "
                    "Do not generate or change any action, reaction, speech, or delivery. Use rendered_scene as the exact final text; "
                    "the host validates byte-for-byte text and slice order. The host separately reads every turn for character, motive, "
                    "causal, and manner quality; hashes and semantic verdicts do not prove literary quality.")}
    return {"session_id": state["session_id"], "source_fingerprint": state["source_fingerprint"],
            "transcript_sha256": state["final_transcript_sha256"],
            "complete_accepted_transcript": public, "hero_private_experience": hero_private,
            "hero_name": state["hero_name"],
            "formatter_craft": copy.deepcopy(craft["formatter"]),
            "author_samples": copy.deepcopy(craft["author_samples"]),
            "character_voice_evidence": copy.deepcopy(craft.get("character_voice_evidence", {})),
            "character_relationship_evidence": copy.deepcopy(state["bundle"].get("relationship_samples", [])),
            "frozen_hero_spans": [e.get("private_text") or e.get("text") for e in state["transcript"]
                if not e.get("source_history") and (
                    (e.get("private_text") and e.get("speaker_role") == "hero") or
                    (e.get("speaker_role") == "hero" and e.get("kind") in _LIVE_EVENT_KINDS))],
            "frozen_ordered_spans": [e.get("private_text") or e.get("text") for e in state["transcript"]
                if not e.get("source_history") and (
                    (e.get("private_text") and e.get("speaker_role") == "hero") or
                    (e.get("speaker_role") == "hero" and e.get("kind") in _LIVE_EVENT_KINDS) or
                    e.get("kind") == "speech")],
            "instruction": "Format the complete newly played accepted causal transcript in the supplied author craft and samples. Source-history events are context only and must not be replayed. Preserve every frozen hero span and all played speech literally and in event order. Add no hero choice, feeling, event, or knowledge. Role labels are diagnostic; produce literary prose."}


def validate_live_prose(formatter_input: dict[str, Any], prose: str, *,
                        semantic_review: dict[str, Any]) -> dict[str, Any]:
    """Check frozen hero text order and require host review of the prose hash."""
    if not isinstance(prose, str) or not prose.strip():
        raise ContextError("formatter prose must be nonempty")
    if "rendered_scene" in formatter_input:
        expected_scene, expected_slices = render_enacted_scene(
            {"transcript": formatter_input.get("complete_accepted_transcript")})
        if formatter_input.get("rendered_scene") != expected_scene:
            raise ContextError("enacted-v2 rendered scene does not match the deterministic render of the accepted transcript")
        if formatter_input.get("ordered_slices") != expected_slices:
            raise ContextError("enacted-v2 ordered slices do not match the deterministic map of the accepted transcript")
        if prose != expected_scene:
            raise ContextError("enacted-v2 final prose must exactly match the deterministic rendered scene and mapped slices")
        digest = _staged_hash({"prose": prose, "transcript_sha256": formatter_input.get("transcript_sha256")})
        if (not isinstance(semantic_review, dict) or semantic_review.get("accepted") is not True or
                semantic_review.get("prose_sha256") != digest or
                semantic_review.get("transcript_sha256") != formatter_input.get("transcript_sha256")):
            raise ContextError("host semantic review must accept this exact rendered scene and transcript")
        return {"accepted": True, "prose_sha256": digest,
                "transcript_sha256": formatter_input["transcript_sha256"],
                "ordered_slices": formatter_input["ordered_slices"]}
    spans = formatter_input.get("frozen_ordered_spans", formatter_input.get("frozen_hero_spans", []))
    cursor = 0
    for span in spans:
        pos = prose.find(span, cursor)
        if pos < 0:
            raise ContextError("final prose omits or reorders a frozen hero span or played speech")
        cursor = pos + len(span)
    digest = _staged_hash({"prose": prose, "transcript_sha256": formatter_input.get("transcript_sha256")})
    if (not isinstance(semantic_review, dict) or semantic_review.get("accepted") is not True or
            semantic_review.get("prose_sha256") != digest or
            semantic_review.get("transcript_sha256") != formatter_input.get("transcript_sha256")):
        raise ContextError("host semantic review must accept this prose against the accepted transcript")
    return {"accepted": True, "prose_sha256": digest, "transcript_sha256": formatter_input["transcript_sha256"]}


# The staged roleplay path is an orchestration API. Its hashes bind artifacts
# to the current branch turn; they do not attest who performed semantic review.
def _staged_hash(value: Any) -> str:
    return _json_hash(value)


def _staged_slot_id(npc: str, facet_id: str, event_index: int) -> str:
    """Encode the slot identity as one unambiguous JSON tuple."""
    return "slot:" + json.dumps([npc, facet_id, event_index], ensure_ascii=False,
                                separators=(",", ":"))


def _staged_source_facts(bundle: dict[str, Any]) -> str:
    """Bind turn facts without exposing this audit hash in actor prompts."""
    intake = bundle.get("turn_intake", {})
    return _staged_hash({"role_memory": bundle.get("role_memory"),
                         "turn_units": intake.get("units"),
                         "physical_staging": bundle.get("physical_staging", {}),
                         "relationship_samples": bundle.get("relationship_samples", [])})


def initialize_staged_turn(bundle: dict[str, Any], hero_action: str,
                           requirements: list[dict[str, Any]]) -> dict[str, Any]:
    """Create JSON-serializable host state for one explicit staged turn."""
    _validate_context_gaps(bundle)
    units = _validate_turn_intake(bundle, hero_action, "leader")
    if not isinstance(requirements, list) or not requirements:
        raise ContextError("staged turn needs explicit NPC question/facet requirements")
    material_unit_ids = {unit["id"] for unit in units
                         if unit["kind"] in {"question", "condition"} and
                         unit["disposition"] != "irrelevant" and
                         unit.get("addressed_to") != ["self"]}
    all_unit_ids = {unit["id"] for unit in units}
    self_private_unit_ids = {unit["id"] for unit in units if unit.get("addressed_to") == ["self"]}
    memories = bundle.get("role_memory", {}).get("leader", {}).get("npc_memories", {})
    normalized, seen = [], set()
    for item in requirements:
        if (not isinstance(item, dict) or set(item) - {"id", "npc", "question", "unit_ids", "public_dialogue_refs"} or
                not {"id", "npc", "question", "unit_ids"} <= set(item) or
                not all(isinstance(item.get(k), str) and item[k].strip() for k in ("id", "npc", "question"))):
            raise ContextError("Each requirement needs id, npc, question, and unit_ids")
        if item["id"] in seen or item["npc"] not in memories:
            raise ContextError("Requirement IDs must be unique and NPC owner must exist")
        seen.add(item["id"])
        refs = item["unit_ids"]
        if not isinstance(refs, list) or not refs or not set(refs) <= all_unit_ids:
            raise ContextError(f"Requirement {item['id']} needs valid perceived public unit IDs")
        if set(refs) & self_private_unit_ids:
            raise ContextError(f"Requirement {item['id']} cannot assign a self-private unit as NPC-perceived public material")
        dialogue_refs = item.get("public_dialogue_refs", [])
        if (not isinstance(dialogue_refs, list) or
                not all(isinstance(pointer, str) for pointer in dialogue_refs) or
                len(set(dialogue_refs)) != len(dialogue_refs)):
            raise ContextError(f"Requirement {item['id']} public_dialogue_refs must be unique JSON pointers")
        leader_memory = bundle.get("role_memory", {}).get("leader", {})
        for pointer in dialogue_refs:
            tokens = _gap_pointer_tokens(pointer, gap_id=item["id"])
            lines = leader_memory.get("heard_dialogue", []) if isinstance(leader_memory, dict) else []
            if (tokens[0] != "heard_dialogue" or len(tokens) != 2 or not tokens[1].isdigit() or
                    int(tokens[1]) >= len(lines)):
                raise ContextError("Public dialogue refs must select existing whole leader.heard_dialogue records")
        normalized.append({"id": item["id"], "npc": item["npc"], "question": item["question"],
                           "unit_ids": list(refs), "public_dialogue_refs": list(dialogue_refs)})
    assigned_material = {unit_id for item in normalized for unit_id in item["unit_ids"]} & material_unit_ids
    missing_material = material_unit_ids - assigned_material
    if missing_material:
        raise ContextError("Every material question/condition unit needs an NPC requirement: " + ", ".join(sorted(missing_material)))
    import copy
    return {"version": 1, "phase": "pending_resolutions", "hero_action": hero_action,
            "action_sha256": _staged_hash(hero_action), "requirements": copy.deepcopy(normalized),
            "source_facts_sha256": _staged_source_facts(bundle),
            "candidate_resolutions": {}, "accepted_resolutions": {}, "render": None}


def build_npc_resolution_input(state: dict[str, Any], bundle: dict[str, Any], npc: str) -> dict[str, Any]:
    """Project one NPC's own memory plus the explicitly perceived public spans."""
    if state.get("phase") != "pending_resolutions" or state.get("action_sha256") != _staged_hash(state.get("hero_action")):
        raise ContextError("NPC resolution requires the current pending turn")
    _validate_turn_intake(bundle, state["hero_action"], "leader")
    if _staged_source_facts(bundle) != state.get("source_facts_sha256"):
        raise ContextError("NPC source facts changed after staged turn preparation")
    requirements = [r for r in state.get("requirements", []) if r["npc"] == npc]
    if not requirements:
        raise ContextError(f"No current requirements belong to NPC {npc}")
    memories = bundle.get("role_memory", {}).get("leader", {}).get("npc_memories", {})
    if npc not in memories:
        raise ContextError("NPC owner is absent from current bundle")
    units = {u["id"]: u for u in bundle.get("turn_intake", {}).get("units", [])}
    selected_ids = list(dict.fromkeys(uid for r in requirements for uid in r["unit_ids"]))
    if any(uid not in units for uid in selected_ids):
        raise ContextError("Perceived public unit is stale")
    dialogue_refs = list(dict.fromkeys(ref for r in requirements for ref in r["public_dialogue_refs"]))
    dialogue = bundle.get("role_memory", {}).get("leader", {}).get("heard_dialogue", [])
    public_dialogue = []
    for pointer in dialogue_refs:
        index = int(_gap_pointer_tokens(pointer, gap_id="public_dialogue")[-1])
        line = dialogue[index]
        if not isinstance(line, dict) or not {"speaker", "recipient", "text"} <= set(line):
            raise ContextError("Selected public dialogue record is incomplete")
        public_dialogue.append({"reference": pointer, "speaker": line["speaker"],
                                "recipient": line["recipient"], "text": line["text"],
                                **({"manner": line["manner"]} if "manner" in line else {})})
    import copy
    return {"stage": "npc_resolution", "npc": npc,
            "action_sha256": state["action_sha256"],
            "source_facts_sha256": state["source_facts_sha256"],
            "perceived_public_action": [copy.deepcopy(units[uid]) for uid in selected_ids],
            "perceived_public_dialogue": copy.deepcopy(public_dialogue),
            "own_memory": copy.deepcopy(memories[npc]),
            "requirements": copy.deepcopy(requirements),
            "instruction": "Return one facet per assigned requirement, using status addressed, condition, unknown, source_gap, or irrelevant. Each facet has public_events: [{kind: utterance, recipient: person/group, text: actual spoken words now}], knowledge_refs: [{kind: memory, id: /experience/0}] or perceived public_unit/public_dialogue references, and a brief source-grounded basis. Deliver available answer content in the actual utterances rather than a plan to explain it later. Do not write hero replies, outcomes, private analysis, or prose framing. A source gap is not evidence of NPC ignorance."}


def validate_npc_resolution(state: dict[str, Any], bundle: dict[str, Any], npc: str,
                            response: dict[str, Any]) -> dict[str, Any]:
    if state.get("phase") != "pending_resolutions" or state.get("action_sha256") != _staged_hash(state.get("hero_action")):
        raise ContextError("NPC resolution is stale or turn is no longer pending")
    _validate_turn_intake(bundle, state["hero_action"], "leader")
    if _staged_source_facts(bundle) != state.get("source_facts_sha256"):
        raise ContextError("NPC source facts changed after staged turn preparation")
    required = [r for r in state["requirements"] if r["npc"] == npc]
    if not required or not isinstance(response, dict) or set(response) != {"npc", "action_sha256", "source_facts_sha256", "facets"}:
        raise ContextError("Resolution needs its owner, action/source hashes, and facet records")
    if (response["npc"] != npc or response["action_sha256"] != state["action_sha256"] or
            response["source_facts_sha256"] != state["source_facts_sha256"]):
        raise ContextError("Resolution owner or action binding does not match current turn")
    facets = response["facets"]
    if not isinstance(facets, list) or {f.get("id") for f in facets if isinstance(f, dict)} != {r["id"] for r in required} or len(facets) != len(required):
        raise ContextError("Resolution must cover every assigned facet exactly once")
    own = bundle.get("role_memory", {}).get("leader", {}).get("npc_memories", {}).get(npc)
    if not isinstance(own, dict):
        raise ContextError("Current NPC owner memory is missing")
    perceived_unit_ids = {unit_id for requirement in required for unit_id in requirement["unit_ids"]}
    allowed_dialogue = {pointer for r in required for pointer in r["public_dialogue_refs"]}
    for facet in facets:
        if set(facet) != {"id", "status", "public_events", "knowledge_refs", "basis"}:
            raise ContextError("Facet has unknown or missing fields")
        if facet["status"] not in {"addressed", "condition", "unknown", "source_gap", "irrelevant"}:
            raise ContextError("Invalid facet status")
        if not isinstance(facet["public_events"], list) or not isinstance(facet["basis"], str):
            raise ContextError("Facet public_events must be a list and basis must be a string")
        for event in facet["public_events"]:
            if (not isinstance(event, dict) or set(event) != {"kind", "recipient", "text"} or
                    event.get("kind") != "utterance" or
                    not isinstance(event.get("recipient"), str) or not event["recipient"].strip() or
                    not isinstance(event.get("text"), str) or not event["text"].strip()):
                raise ContextError("Each public event must contain a concrete utterance kind, recipient, and text")
        refs = facet["knowledge_refs"]
        if not isinstance(refs, list):
            raise ContextError("knowledge_refs must be a list")
        for ref in refs:
            if not isinstance(ref, dict) or set(ref) != {"kind", "id"}:
                raise ContextError("Knowledge reference must identify one owned memory item or public unit")
            if ref["kind"] == "public_unit":
                if ref["id"] not in perceived_unit_ids:
                    raise ContextError("Knowledge reference names a unit not explicitly perceived by this NPC")
            elif ref["kind"] == "public_dialogue":
                if ref["id"] not in allowed_dialogue:
                    raise ContextError("Knowledge reference names dialogue not explicitly perceived by this NPC")
            elif ref["kind"] == "memory":
                pointer = ref["id"]
                tokens = _gap_pointer_tokens(pointer, gap_id=facet["id"])
                value: Any = own
                for token in tokens:
                    if isinstance(value, dict) and token in value:
                        value = value[token]
                    elif isinstance(value, list) and token.isdigit() and int(token) < len(value):
                        value = value[int(token)]
                    else:
                        raise ContextError("Knowledge reference is outside this NPC's memory")
            else:
                raise ContextError("Unknown knowledge reference kind")
        if facet["status"] in {"addressed", "condition"} and not facet["public_events"]:
            raise ContextError("Addressed/conditional facet needs at least one concrete public event")
    import copy
    candidate = copy.deepcopy(response)
    state.setdefault("candidate_resolutions", {})[npc] = {"value": candidate, "sha256": _staged_hash(candidate)}
    return candidate


def accept_npc_resolution(state: dict[str, Any], npc: str, review: dict[str, Any]) -> dict[str, Any]:
    candidate = state.get("candidate_resolutions", {}).get(npc)
    if not candidate or not isinstance(review, dict) or set(review) != {"accepted", "candidate_sha256", "findings"}:
        raise ContextError("Host review must explicitly bind to the current candidate")
    if review["candidate_sha256"] != candidate["sha256"] or not isinstance(review["accepted"], bool) or not isinstance(review["findings"], list):
        raise ContextError("Host review is stale or malformed")
    if not review["accepted"]:
        state.setdefault("accepted_resolutions", {}).pop(npc, None)
        state["phase"] = "resolution_rejected"
        state.setdefault("rejected_resolutions", {})[npc] = {"candidate_sha256": candidate["sha256"], "review": review}
        return {"npc": npc, "candidate_sha256": candidate["sha256"], "accepted": False, "receipt": _staged_hash({"npc": npc, "candidate_sha256": candidate["sha256"], "review": review})}
    state.setdefault("accepted_resolutions", {})[npc] = {"candidate_sha256": candidate["sha256"], "review": review,
                                                          "receipt": _staged_hash({"npc": npc, "candidate_sha256": candidate["sha256"], "review": review})}
    expected = {r["npc"] for r in state["requirements"]}
    if expected <= set(state["accepted_resolutions"]):
        state["phase"] = "ready_to_render"
    return {"npc": npc, "candidate_sha256": candidate["sha256"], "receipt": state["accepted_resolutions"][npc]["receipt"]}


def build_render_input(state: dict[str, Any], bundle: dict[str, Any]) -> dict[str, Any]:
    if state.get("phase") != "ready_to_render":
        raise ContextError("Rendering requires every current NPC resolution to be accepted")
    _validate_turn_intake(bundle, state["hero_action"], "leader")
    if _staged_source_facts(bundle) != state.get("source_facts_sha256"):
        raise ContextError("NPC source facts changed after staged turn preparation")
    _validate_ready_resolution_bindings(state)
    utterance_slots = []
    for npc, accepted in state["accepted_resolutions"].items():
        candidate = state["candidate_resolutions"].get(npc, {})
        if candidate.get("sha256") != accepted.get("candidate_sha256"):
            raise ContextError("Accepted resolution binding is stale")
        for facet in candidate["value"]["facets"]:
            for event_index, event in enumerate(facet["public_events"]):
                utterance_slots.append({"slot_id": _staged_slot_id(npc, facet["id"], event_index),
                                        "npc": npc, **event})
    safe = {key: bundle[key] for key in ("physical_staging", "relationship_samples") if key in bundle}
    import copy
    return {"stage": "render", "frozen_segments": [
                {"kind": "hero_action", "text": state["hero_action"]},
                *[{**slot, "segment_kind": "utterance_slot"} for slot in copy.deepcopy(utterance_slots)]],
            "physical_staging": copy.deepcopy(safe.get("physical_staging", {})),
            "relationship_samples": copy.deepcopy(safe.get("relationship_samples", [])),
            "instruction": "Return framing entries keyed by each utterance slot_id only. Do not rewrite, paraphrase, omit, reorder, or append to the frozen hero action or NPC utterances; the host assembles the final scene."}


def record_staged_framing(state: dict[str, Any], bundle: dict[str, Any], framing: Any) -> list[dict[str, str]]:
    """Validate and retain renderer framing, then return the assembled literal scene."""
    scene = assemble_staged_scene(state, bundle, framing)
    import copy
    state["render_framing"] = copy.deepcopy(framing)
    state["assembled_scene"] = scene
    return scene


def assemble_staged_scene(state: dict[str, Any], bundle: dict[str, Any], framing: Any) -> str:
    """Deterministically assemble framing around frozen hero and NPC utterances."""
    if state.get("phase") != "ready_to_render":
        raise ContextError("Scene assembly requires every current NPC resolution to be accepted")
    _validate_current_staged_bundle(state, bundle)
    _validate_ready_resolution_bindings(state)
    slots = []
    for npc, accepted in state["accepted_resolutions"].items():
        candidate = state["candidate_resolutions"][npc]
        for facet in candidate["value"]["facets"]:
            for event_index, event in enumerate(facet["public_events"]):
                slots.append({"slot_id": _staged_slot_id(npc, facet["id"], event_index), "npc": npc, **event})
    if not isinstance(framing, list) or len(framing) != len(slots):
        raise ContextError("Renderer framing must cover every frozen utterance slot exactly once")
    by_id = {}
    for entry in framing:
        if (not isinstance(entry, dict) or set(entry) != {"slot_id", "before", "after"} or
                not isinstance(entry.get("slot_id"), str) or
                not isinstance(entry.get("before"), str) or not isinstance(entry.get("after"), str) or
                entry["slot_id"] in by_id):
            raise ContextError("Each renderer framing entry needs a unique slot ID and before/after text")
        by_id[entry["slot_id"]] = entry
    if set(by_id) != {slot["slot_id"] for slot in slots}:
        raise ContextError("Renderer framing slot IDs do not match the frozen utterances")
    parts = [state["hero_action"]]
    for index, slot in enumerate(slots):
        frame = by_id[slot["slot_id"]]
        parts.extend(["\n\n", frame["before"].strip(), "\n\n",
                      f"{slot['npc']}:\n— {slot['text']}"])
        if frame["after"].strip():
            parts.extend(["\n\n", frame["after"].strip()])
    return "".join(parts)


def _validate_current_staged_bundle(state: dict[str, Any], bundle: dict[str, Any]) -> None:
    _validate_turn_intake(bundle, state.get("hero_action"), "leader")
    if _staged_source_facts(bundle) != state.get("source_facts_sha256"):
        raise ContextError("Current source facts or staging no longer match the prepared turn")


def _validate_ready_resolution_bindings(state: dict[str, Any]) -> None:
    expected = {r["npc"] for r in state.get("requirements", [])}
    if not expected or state.get("accepted_resolutions", {}).keys() < expected:
        raise ContextError("Every required NPC resolution must be accepted before render or commit")
    for npc in expected:
        candidate = state.get("candidate_resolutions", {}).get(npc)
        accepted = state.get("accepted_resolutions", {}).get(npc)
        if not candidate or not accepted or candidate.get("sha256") != _staged_hash(candidate.get("value")):
            raise ContextError("Accepted NPC resolution candidate is missing or changed")
        value, review = candidate["value"], accepted.get("review")
        if (value.get("npc") != npc or value.get("action_sha256") != state.get("action_sha256") or
                value.get("source_facts_sha256") != state.get("source_facts_sha256") or
                accepted.get("candidate_sha256") != candidate["sha256"] or
                not isinstance(review, dict) or review.get("accepted") is not True or
                review.get("candidate_sha256") != candidate["sha256"] or
                accepted.get("receipt") != _staged_hash({"npc": npc, "candidate_sha256": candidate["sha256"], "review": review})):
            raise ContextError("NPC acceptance is stale or not bound to the current action/source facts")


def accept_staged_scene(state: dict[str, Any], bundle: dict[str, Any], scene: str,
                        review: dict[str, Any]) -> dict[str, Any]:
    if state.get("phase") != "ready_to_render" or not isinstance(scene, str) or not scene.strip():
        raise ContextError("Scene acceptance requires the rendered current turn")
    _validate_current_staged_bundle(state, bundle)
    _validate_ready_resolution_bindings(state)
    digest = _staged_hash(scene)
    if (not isinstance(review, dict) or set(review) != {"accepted", "scene_sha256", "findings"} or
            review.get("scene_sha256") != digest or not isinstance(review.get("accepted"), bool) or not isinstance(review.get("findings"), list)):
        raise ContextError("Host scene review must bind to the literal current scene")
    expected_scene = assemble_staged_scene(state, bundle, state.get("render_framing"))
    if scene != expected_scene:
        raise ContextError("Scene must equal deterministic assembly of the exact hero action and frozen NPC utterances")
    if not review["accepted"]:
        state["phase"] = "scene_rejected"
        state["render"] = None
        state["rejected_scene"] = {"scene_sha256": digest, "review": review}
        return {"scene_sha256": digest, "accepted": False,
                "receipt": _staged_hash({"scene_sha256": digest, "review": review})}
    state["phase"] = "scene_accepted"
    state["render"] = {"scene": scene, "scene_sha256": digest,
                        "review": review,
                        "receipt": _staged_hash({"scene_sha256": digest, "review": review})}
    return {"scene_sha256": digest, "receipt": state["render"]["receipt"]}


def commit_staged_turn(state: dict[str, Any], bundle: dict[str, Any]) -> dict[str, Any]:
    if state.get("phase") != "scene_accepted" or not state.get("render"):
        raise ContextError("Turn commit requires accepted literal scene")
    _validate_current_staged_bundle(state, bundle)
    _validate_ready_resolution_bindings(state)
    rendered = state["render"]
    if (rendered.get("scene_sha256") != _staged_hash(rendered.get("scene")) or
            not isinstance(rendered.get("review"), dict) or rendered["review"].get("accepted") is not True or
            rendered["review"].get("scene_sha256") != rendered.get("scene_sha256") or
            rendered.get("receipt") != _staged_hash({"scene_sha256": rendered["scene_sha256"], "review": rendered["review"]})):
        raise ContextError("Accepted scene receipt is stale or changed")
    state["phase"] = "committed"
    return {"phase": "committed", "scene": state["render"]["scene"],
            "scene_sha256": state["render"]["scene_sha256"]}


def build_next_hero_input(state: dict[str, Any], bundle: dict[str, Any],
                          contract: Any, craft_input: Any = None) -> dict[str, Any]:
    """Expose the committed accepted scene to the hero stage only after commit."""
    if state.get("phase") != "committed" or not state.get("render"):
        raise ContextError("Next hero input requires the prior accepted scene to be committed")
    import copy
    hero_bundle = copy.deepcopy(bundle)
    hero_bundle.pop("turn_intake", None)
    payload = build_actor_input(hero_bundle, "hero", contract, craft_input)
    payload["accepted_scene"] = state["render"]["scene"]
    payload["accepted_scene_sha256"] = state["render"]["scene_sha256"]
    return payload


def resolve_fact_target(fact: dict[str, Any]) -> str:
    """Resolve a fact target while enforcing the hero audience boundary."""
    target = fact.get("target")
    if target is None:
        target = ("hero.knowledge" if "hero" in fact.get("known_to", []) and
                  "hero" in fact.get("required_roles", []) else "world.rules")
    if target not in FACT_TARGETS:
        raise ContextError(f"Invalid fact target in {fact.get('id')}")
    if target.startswith("hero.") and fact.get("status") == "active":
        if "hero" not in fact.get("known_to", []) or "hero" not in fact.get("required_roles", []):
            raise ContextError(f"Active hero target {fact.get('id')} requires hero in known_to and required_roles")
    return target


def validate_inventory(request: dict[str, Any], source_packet: dict[str, Any], inventory: dict[str, Any], audit: dict[str, Any] | None, *, trusted_receipt: bool = False) -> dict[str, Any]:
    if not isinstance(inventory, dict) or inventory.get("context_version") != 2:
        raise ContextError("Inventory context_version 2 is required")
    constraints = request.get("author_constraints", [])
    constraint_ids = {c.get("id") for c in constraints if isinstance(c, dict)} if isinstance(constraints, list) else set()
    if not isinstance(constraints, list) or len(constraint_ids) != len(constraints) or not all(isinstance(c, dict) and isinstance(c.get("text"), str) and c["text"].strip() for c in constraints):
        raise ContextError("Author constraints must be unique literal records")
    if inventory.get("request") != request:
        raise ContextError("Inventory request does not match current request")
    unit_ids = {f"{s['source_id']}#{u['unit_id']}" for s in source_packet.get("sources", []) for u in s.get("units", [])}
    coverage = inventory.get("unit_coverage")
    covered = {f"{c.get('source_id')}#{c.get('unit_id')}" for c in coverage or [] if isinstance(c, dict)}
    if covered != unit_ids or len(coverage or []) != len(unit_ids):
        raise ContextError("Every source unit needs exactly one coverage record")
    fact_ids = {f.get("id") for f in inventory.get("facts", []) if isinstance(f, dict)}
    if len(fact_ids) != len(inventory.get("facts", [])):
        raise ContextError("Facts need unique IDs")
    for c in coverage:
        if not set(c.get("fact_ids", [])) <= fact_ids:
            raise ContextError("Unit coverage references missing fact")
        excluded = c.get("excluded_parts", [])
        if not c.get("fact_ids") and (not excluded or not all(isinstance(e, dict) and e.get("reason") for e in excluded)):
            raise ContextError("Uncovered source unit needs explicit exclusions with reasons")
    constraint_coverage = {x for f in inventory.get("facts", []) for x in f.get("author_constraint_ids", [])}
    if not constraint_ids <= constraint_coverage:
        raise ContextError("Every literal author constraint must be represented in facts")
    source_units = {f"{s['source_id']}#{u['unit_id']}": u["text"] for s in source_packet.get("sources", []) for u in s.get("units", [])}
    for f in inventory.get("facts", []):
        resolve_fact_target(f)
        if f.get("status") not in {"active", "superseded", "unknown"}:
            raise ContextError(f"Invalid status for fact {f.get('id')}")
        if not set(f.get("author_constraint_ids", [])) <= constraint_ids or not set(f.get("required_roles", [])) <= ROLES:
            raise ContextError(f"Invalid constraint or role mapping in fact {f.get('id')}")
        if not isinstance(f.get("scene_influence"), str) or len(f["scene_influence"].strip()) < 3:
            raise ContextError(f"Fact {f.get('id')} needs scene influence")
        if not f.get("evidence") and not f.get("author_constraint_ids"):
            raise ContextError(f"Fact {f.get('id')} needs source or literal author evidence")
        if "hero" in f.get("required_roles", []) and "hero" not in f.get("known_to", []):
            raise ContextError(f"Leader-only fact {f.get('id')} cannot enter hero context")
        if f.get("status") != "active" and ("hero" in f.get("required_roles", []) or "formatter" in f.get("required_roles", [])):
            raise ContextError(f"Non-active fact {f.get('id')} cannot be delivered as a current hero or formatter fact")
        for ref in f.get("evidence", []):
            key = f"{ref.get('source_id')}#{ref.get('unit_id')}"
            if key not in unit_ids or not isinstance(ref.get("quote"), str) or ref["quote"] not in source_units[key]:
                raise ContextError(f"Fact {f.get('id')} cites a missing source unit")
    constraint_text = {c["id"]: c["text"] for c in constraints}
    for role, packets in build_role_packets(inventory).items():
        linked = {c for p in packets for c in p.get("author_constraint_ids", [])}
        for cid in linked:
            if constraint_text[cid] not in json.dumps(packets, ensure_ascii=False):
                raise ContextError(f"Role packet {role} loses literal author constraint {cid}")
    fact_by_id = {f["id"]: f for f in inventory.get("facts", [])}
    for conflict in inventory.get("conflicts", []):
        claims = conflict.get("claims") if isinstance(conflict, dict) else None
        choice = conflict.get("active_choice") if isinstance(conflict, dict) else None
        if not isinstance(claims, list) or len(claims) < 2 or not isinstance(choice, dict) or not all(choice.get(k) for k in ("fact_id", "local_scope", "basis")):
            raise ContextError("Conflicts need both claims and a scoped active choice with basis")
        for claim in claims:
            f = fact_by_id.get(claim.get("fact_id")) if isinstance(claim, dict) else None
            if not f or claim.get("claim") != f["claim"] or claim.get("status") != f["status"]:
                raise ContextError("Conflict claim disagrees with its referenced fact")
        chosen = fact_by_id.get(choice["fact_id"])
        if not chosen or chosen.get("status") != "active" or not any(c["fact_id"] == choice["fact_id"] for c in claims):
            raise ContextError("Conflict active choice must reference an active listed claim")
    unknown_ids = set()
    for unknown in inventory.get("unknowns", []):
        if not isinstance(unknown, dict) or not all(isinstance(unknown.get(k), str) and unknown[k].strip() for k in ("id", "gap", "blocks_when")):
            raise ContextError("Unknowns need an ID, concrete gap, and condition for blocking")
        if unknown["id"] in unknown_ids:
            raise ContextError("Unknown IDs must be unique")
        unknown_ids.add(unknown["id"])
    expected = build_role_packets(inventory)
    if inventory.get("role_packets") != expected:
        raise ContextError("role_packets are not the deterministic inventory projection")
    digest = _json_hash({"facts": inventory.get("facts"), "unit_coverage": coverage, "conflicts": inventory.get("conflicts"), "unknowns": inventory.get("unknowns")})
    req_hash, src_hash, inv_hash, role_hash = map(_json_hash, (request, source_packet, inventory, expected))
    assembly_run = request.get("assembly_run_id")
    audit_ok = trusted_receipt and isinstance(audit, dict) and audit.get("schema_version") == 1 and audit.get("request_sha256") == req_hash and audit.get("source_packet_sha256") == src_hash and audit.get("inventory_sha256") == inv_hash and audit.get("role_packets_sha256") == role_hash and audit.get("run_id") and audit.get("run_id") != assembly_run and audit.get("identity") and isinstance(audit.get("findings"), list) and isinstance(audit.get("blockers"), list)
    if audit_ok and audit.get("provenance") not in {"trusted_host_review", "caller_supplied"}:
        audit_ok = False
    trusted_current = bool(audit_ok and audit.get("provenance") == "trusted_host_review" and not audit.get("blockers"))
    return {"structural_complete": True, "analysis_ready": trusted_current,
            "semantic_audit_current": bool(audit_ok),
            "audit_provenance": audit.get("provenance") if audit_ok else None,
            "audit_findings": audit.get("findings", []) if audit_ok else [],
            "concrete_context_complete": False,
            "offerable": False,
            "allow_roleplay": request.get("allow_roleplay") is True,
            "inventory_sha256": inv_hash, "role_packets_sha256": role_hash,
            "coverage_sha256": digest,
            "limitation": "Completeness applies only to declared bounded sources. Meaning inside source units requires independent semantic review; hashes bind a review to data but do not establish reviewer provenance."}


def check_context(vault_root: Path, request: dict[str, Any], inventory: dict[str, Any], receipt_ref: dict[str, Any] | None = None, project_root: Path | None = None) -> dict[str, Any]:
    prepared = prepare_context(vault_root, request)
    receipt = None
    if isinstance(receipt_ref, dict) and project_root is not None:
        rid = receipt_ref.get("receipt_id")
        if not isinstance(rid, str) or not ID.fullmatch(rid):
            raise ContextError("semantic_audit.receipt_id is required")
        project = Path(project_root).expanduser().resolve()
        audit_dir = project / ".talewisp" / "context-audits"
        path = audit_dir / f"{rid}.json"
        if any(p.is_symlink() or (hasattr(p, "is_junction") and p.is_junction()) for p in (project / ".talewisp", audit_dir, path)) or not path.resolve().is_relative_to(audit_dir.resolve()):
            raise ContextError("Audit receipt path escapes the fixed context-audits directory")
        try:
            receipt = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            receipt = None
    result = validate_inventory(request, prepared["source_packet"], inventory, receipt, trusted_receipt=receipt is not None)
    result["source_packet"] = prepared["source_packet"]
    result["source_packet_sha256"] = prepared["source_packet_sha256"]
    result["expected_unit_ids"] = prepared["expected_unit_ids"]
    return result
