"""Compile an explicit, source-grounded knowledge structure into a safe index.

This module validates structure; it does not infer ontology or write files.
Semantic extraction and interpretation belong to the bounded host analysis.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path, PurePosixPath
from typing import Any


SCHEMA = "talewisp-knowledge-structure-v1"
MAX_SOURCE_BYTES = 32 * 1024 * 1024
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class KnowledgeStructureError(ValueError):
    """The supplied structure is incomplete, inconsistent, or unsafe."""


def _fail(message: str) -> None:
    raise KnowledgeStructureError(message)


def _mapping(value: Any, where: str, allowed: set[str] | None = None) -> dict:
    if not isinstance(value, dict):
        _fail(f"{where} must be an object")
    if allowed is not None:
        _known_fields(value, allowed, where)
    return value


def _known_fields(row: dict, allowed: set[str], where: str) -> None:
    unsupported = sorted(set(row) - allowed)
    if unsupported:
        _fail(f"Unsupported fields at {where}: {', '.join(unsupported)}")


def _qualifier(value: Any, where: str) -> str | list[str]:
    if isinstance(value, str):
        return _text(value, where)
    if isinstance(value, list) and value:
        return [_text(item, f"{where}[{i}]") for i, item in enumerate(value)]
    _fail(f"{where} must be a nonempty string or nonempty array of strings")


def _array(value: Any, where: str) -> list:
    if not isinstance(value, list):
        _fail(f"{where} must be an array")
    return value


def _text(value: Any, where: str, *, empty: bool = False) -> str:
    if not isinstance(value, str) or (not empty and not value.strip()):
        _fail(f"{where} must be a {'possibly empty ' if empty else ''}string")
    return value


def _id(value: Any, where: str) -> str:
    result = _text(value, where)
    if not _ID.fullmatch(result):
        _fail(f"{where} is not a valid durable ID: {result!r}")
    return result


def _unique_id(row: dict, where: str, seen: set[str]) -> str:
    ident = _id(row.get("id"), f"{where}.id")
    if ident in seen:
        _fail(f"Duplicate {where} ID: {ident}")
    seen.add(ident)
    return ident


def _sources(raw: Any, source_root: Path) -> dict[str, dict]:
    root = source_root.expanduser().resolve(strict=True)
    if not root.is_dir():
        _fail("source_root must be an existing directory")
    rows = _array(raw, "sources")
    result: dict[str, dict] = {}
    for i, item in enumerate(rows):
        row = _mapping(item, f"sources[{i}]", {"id", "path", "sha256"})
        ident = _unique_id(row, f"sources[{i}]", set(result))
        rel = _text(row.get("path"), f"sources[{i}].path")
        posix = PurePosixPath(rel)
        if posix.is_absolute() or ".." in posix.parts or "\\" in rel or not posix.parts:
            _fail(f"Source path must be a safe source_root-relative POSIX path: {rel!r}")
        try:
            path = (root / Path(*posix.parts)).resolve(strict=True)
            path.relative_to(root)
        except (OSError, ValueError):
            _fail(f"Source escapes source_root or does not exist: {rel!r}")
        if not path.is_file():
            _fail(f"Source snapshot is not a regular file: {rel!r}")
        expected = _text(row.get("sha256"), f"sources[{i}].sha256").casefold()
        if not re.fullmatch(r"[0-9a-f]{64}", expected):
            _fail(f"Invalid SHA-256 for source {ident}")
        try:
            with path.open("rb") as stream:
                snapshot_bytes = stream.read(MAX_SOURCE_BYTES + 1)
        except OSError as exc:
            _fail(f"Cannot read source snapshot {ident}: {exc}")
        if len(snapshot_bytes) > MAX_SOURCE_BYTES:
            _fail(f"Source snapshot exceeds {MAX_SOURCE_BYTES} bytes: {rel!r}")
        actual = hashlib.sha256(snapshot_bytes).hexdigest()
        if actual != expected:
            _fail(f"Source hash mismatch for {ident}")
        try:
            snapshot = snapshot_bytes.decode("utf-8")
        except UnicodeError as exc:
            _fail(f"Source snapshot {ident} must be readable UTF-8: {exc}")
        result[ident] = {"id": ident, "path": posix.as_posix(), "sha256": actual, "_text": snapshot}
    return result


def _evidence(raw: Any, where: str, sources: dict[str, dict]) -> list[dict]:
    rows = _array(raw, where)
    result = []
    for i, item in enumerate(rows):
        row = _mapping(item, f"{where}[{i}]", {"source_id", "quote", "locator"})
        source_id = _id(row.get("source_id"), f"{where}[{i}].source_id")
        if source_id not in sources:
            _fail(f"Unknown evidence source {source_id} at {where}[{i}]")
        quote = _text(row.get("quote"), f"{where}[{i}].quote")
        if quote not in sources[source_id]["_text"]:
            _fail(f"Evidence quote is not an exact substring of source {source_id} at {where}[{i}]")
        locator = row.get("locator")
        if locator is not None:
            locator = _text(locator, f"{where}[{i}].locator")
        result.append({"source_id": source_id, "quote": quote, "locator": locator})
    if not result:
        _fail(f"{where} must contain at least one evidence quote")
    return result


def _scope(value: Any, where: str) -> list[str] | None:
    if value is None:
        return None
    rows = _array(value, where)
    result = [_id(item, f"{where}[{i}]") for i, item in enumerate(rows)]
    if not result or len(set(result)) != len(result):
        _fail(f"{where} must be null or a non-empty list of unique IDs")
    return sorted(result)


def _coordinate(value: Any, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _fail(f"{where} must be an explicit integer coordinate")
    return value


def _validity(raw: Any, where: str) -> dict | None:
    if raw is None:
        return None
    row = _mapping(raw, where, {"timeline", "from", "to"})
    timeline = _id(row.get("timeline"), f"{where}.timeline")
    start, end = row.get("from"), row.get("to")
    if start is None and end is None:
        _fail(f"{where} needs at least one time boundary")
    if start is not None:
        start = _coordinate(start, f"{where}.from")
    if end is not None:
        end = _coordinate(end, f"{where}.to")
    if start is not None and end is not None and start > end:
        _fail(f"{where} has reversed time boundaries")
    return {"timeline": timeline, "from": start, "to": end}


def _disclosure(raw: Any, where: str) -> dict:
    row = _mapping(raw, where, {"reader", "holders", "author"})
    reader = row.get("reader")
    if reader not in ("public", "hidden") and not isinstance(reader, dict):
        _fail(f"{where}.reader must be public, hidden, or a reveal coordinate")
    if isinstance(reader, dict):
        _known_fields(reader, {"timeline", "at"}, f"{where}.reader")
        reader = {"timeline": _id(reader.get("timeline"), f"{where}.reader.timeline"),
                  "at": _coordinate(reader.get("at"), f"{where}.reader.at")}
    holders = []
    seen = set()
    for i, item in enumerate(_array(row.get("holders"), f"{where}.holders")):
        holder = _mapping(item, f"{where}.holders[{i}]", {"id", "mode", "timeline", "at"})
        ident = _id(holder.get("id"), f"{where}.holders[{i}].id")
        if ident in seen:
            _fail(f"Duplicate holder disclosure {ident} at {where}")
        seen.add(ident)
        mode = holder.get("mode")
        if mode not in ("known", "believed"):
            _fail(f"{where}.holders[{i}].mode must be known or believed")
        holders.append({"id": ident, "mode": mode,
                        "timeline": _id(holder.get("timeline"), f"{where}.holders[{i}].timeline"),
                        "at": _coordinate(holder.get("at"), f"{where}.holders[{i}].at")})
    author = row.get("author")
    if not isinstance(author, bool):
        _fail(f"{where}.author must be an explicit boolean")
    return {"reader": reader, "holders": sorted(holders, key=lambda x: x["id"]), "author": author}


def _author_only_disclosure() -> dict:
    return {"reader": "hidden", "holders": [], "author": True}


def _validate_cycles(views: list[dict]) -> None:
    for view in views:
        parents = {p["node_id"]: p["parent_id"] for p in view["placements"]}
        for node_id, parent_id in parents.items():
            if parent_id is not None and parent_id not in parents:
                _fail(f"Parent {parent_id} is not placed in view {view['id']} for node {node_id}")
        for node_id in parents:
            seen = set()
            cursor = node_id
            while cursor is not None:
                if cursor in seen:
                    _fail(f"Parent cycle in view {view['id']} at node {cursor}")
                seen.add(cursor)
                cursor = parents.get(cursor)


def _validate_relation_cycles(relations: list[dict], predicates: dict[str, dict]) -> None:
    groups: dict[str, dict[str, list[dict]]] = {}
    for edge in relations:
        rule = predicates[edge["predicate"]]
        if rule["cycles"] != "forbid" or edge["direction"] != "directed":
            continue
        groups.setdefault(edge["predicate"], {}).setdefault(edge["source"], []).append(edge)

    def merge_scope(left: list[str] | None, right: list[str] | None):
        if left is None:
            return right
        if right is None:
            return left
        overlap = sorted(set(left) & set(right))
        return overlap if overlap else False

    def merge_time(left: dict | None, right: dict | None):
        if left is None:
            return right
        if right is None:
            return left
        if left["timeline"] != right["timeline"]:
            return False
        start_values = [v for v in (left["from"], right["from"]) if v is not None]
        end_values = [v for v in (left["to"], right["to"]) if v is not None]
        start = max(start_values) if start_values else None
        end = min(end_values) if end_values else None
        if start is not None and end is not None and start > end:
            return False
        return {"timeline": left["timeline"], "from": start, "to": end}

    visits = 0
    for predicate, graph in groups.items():
        starts = sorted(set(graph) | {edge["target"] for edges in graph.values() for edge in edges})
        for start in starts:
            def walk(node: str, path: set[str], world: list[str] | None,
                     version: list[str] | None, validity: dict | None) -> None:
                nonlocal visits
                visits += 1
                if visits > 100000:
                    _fail("Relationship cycle analysis exceeded its safe work limit")
                for edge in graph.get(node, ()):
                    next_world = merge_scope(world, edge["world_scope"])
                    next_version = merge_scope(version, edge["version_scope"])
                    next_time = merge_time(validity, edge["validity"])
                    if next_world is False or next_version is False or next_time is False:
                        continue
                    target = edge["target"]
                    if target == start or target in path:
                        _fail(f"Forbidden relationship cycle for predicate {predicate} in overlapping scope")
                    walk(target, path | {target}, next_world, next_version, next_time)

            walk(start, {start}, None, None, None)


def compile_structure(spec: dict, source_root: Path) -> dict:
    """Validate and normalize an explicit source-grounded specification.

    The returned candidate is deterministic and read-only with respect to
    source files. Every definition/relation/event requires literal evidence.
    """
    spec = _mapping(spec, "spec", {"schema", "sources", "nodes", "views", "predicates",
                                    "relations", "events", "redirects"})
    if spec.get("schema") != SCHEMA:
        _fail(f"schema must be {SCHEMA}")
    sources = _sources(spec.get("sources"), Path(source_root))
    nodes: list[dict] = []
    node_ids: set[str] = set()
    definition_ids: set[str] = set()
    for i, item in enumerate(_array(spec.get("nodes"), "nodes")):
        row = _mapping(item, f"nodes[{i}]", {"id", "title", "type", "role", "aliases",
                                              "public_navigation", "label_disclosure", "definitions"})
        ident = _unique_id(row, f"nodes[{i}]", node_ids)
        aliases = []
        for j, raw_alias in enumerate(_array(row.get("aliases", []), f"nodes[{i}].aliases")):
            alias_where = f"nodes[{i}].aliases[{j}]"
            if isinstance(raw_alias, str):
                alias_text, alias_disclosure = _text(raw_alias, alias_where), _author_only_disclosure()
            else:
                alias_row = _mapping(raw_alias, alias_where, {"text", "disclosure"})
                alias_text = _text(alias_row.get("text"), alias_where + ".text")
                alias_disclosure = _disclosure(alias_row.get("disclosure", _author_only_disclosure()), alias_where + ".disclosure")
            aliases.append({"text": alias_text, "disclosure": alias_disclosure})
        public_navigation = row.get("public_navigation", False)
        if not isinstance(public_navigation, bool):
            _fail(f"nodes[{i}].public_navigation must be boolean")
        definitions = []
        for j, raw_def in enumerate(_array(row.get("definitions"), f"nodes[{i}].definitions")):
            definition = _mapping(raw_def, f"nodes[{i}].definitions[{j}]",
                                  {"id", "text", "basis", "status", "world_scope", "version_scope",
                                   "validity", "disclosure", "evidence"})
            did = _unique_id(definition, f"nodes[{i}].definitions[{j}]", definition_ids)
            validity = _validity(definition.get("validity"), f"definition {did}.validity")
            status = _text(definition.get("status"), f"definition {did}.status")
            basis = _text(definition.get("basis"), f"definition {did}.basis")
            definitions.append({"id": did, "text": _text(definition.get("text"), f"definition {did}.text"),
                                "basis": basis, "status": status,
                                "world_scope": _scope(definition.get("world_scope"), f"definition {did}.world_scope"),
                                "version_scope": _scope(definition.get("version_scope"), f"definition {did}.version_scope"),
                                "validity": validity,
                                "disclosure": _disclosure(definition.get("disclosure"), f"definition {did}.disclosure"),
                                "evidence": _evidence(definition.get("evidence"), f"definition {did}.evidence", sources)})
        nodes.append({"id": ident, "title": _text(row.get("title"), f"nodes[{i}].title"),
                      "type": _text(row.get("type"), f"nodes[{i}].type"),
                      "role": _text(row.get("role"), f"nodes[{i}].role", empty=True),
                      "aliases": sorted(aliases, key=lambda a: a["text"].casefold()),
                      "label_disclosure": _disclosure(row.get("label_disclosure", _author_only_disclosure()), f"node {ident}.label_disclosure"),
                      "public_navigation": public_navigation,
                      "definitions": sorted(definitions, key=lambda d: d["id"])})
    nodes.sort(key=lambda n: n["id"])

    views: list[dict] = []
    view_ids: set[str] = set()
    for i, item in enumerate(_array(spec.get("views"), "views")):
        row = _mapping(item, f"views[{i}]", {"id", "title", "placements"})
        vid = _unique_id(row, f"views[{i}]", view_ids)
        placements = []
        placed: set[str] = set()
        for j, raw_place in enumerate(_array(row.get("placements"), f"views[{i}].placements")):
            place = _mapping(raw_place, f"views[{i}].placements[{j}]",
                             {"node_id", "parent_id", "axis", "basis"})
            node_id = _id(place.get("node_id"), f"views[{i}].placements[{j}].node_id")
            parent_id = place.get("parent_id")
            if node_id not in node_ids or (parent_id is not None and _id(parent_id, f"views[{i}].placements[{j}].parent_id") not in node_ids):
                _fail(f"Unknown node endpoint in view {vid}")
            if node_id in placed:
                _fail(f"Node {node_id} has more than one primary placement in view {vid}")
            placed.add(node_id)
            placements.append({"node_id": node_id, "parent_id": parent_id,
                               "axis": _text(place.get("axis"), f"placement {node_id}.axis"),
                               "basis": _text(place.get("basis"), f"placement {node_id}.basis")})
        views.append({"id": vid, "title": _text(row.get("title"), f"views[{i}].title"),
                      "placements": sorted(placements, key=lambda p: p["node_id"])})
    views.sort(key=lambda v: v["id"])
    _validate_cycles(views)

    predicates: dict[str, dict] = {}
    for i, item in enumerate(_array(spec.get("predicates"), "predicates")):
        row = _mapping(item, f"predicates[{i}]", {"name", "meaning", "source_role", "target_role",
                                                   "direction", "cycles", "transitive"})
        name = _id(row.get("name"), f"predicates[{i}].name")
        if name in predicates:
            _fail(f"Duplicate predicate declaration: {name}")
        direction, cycles, transitive = row.get("direction"), row.get("cycles"), row.get("transitive")
        if direction not in ("directed", "symmetric", "unspecified") or cycles not in ("allow", "forbid") or not isinstance(transitive, bool):
            _fail(f"Invalid direction/cycle/transitive policy for predicate {name}")
        if cycles == "forbid" and direction != "directed":
            _fail(f"cycles='forbid' is supported only for directed predicate {name}")
        predicates[name] = {"name": name, "meaning": _text(row.get("meaning"), f"predicate {name}.meaning"),
                            "source_role": _text(row.get("source_role"), f"predicate {name}.source_role"),
                            "target_role": _text(row.get("target_role"), f"predicate {name}.target_role"),
                            "direction": direction, "cycles": cycles, "transitive": transitive}
    relations: list[dict] = []
    relation_ids: set[str] = set()
    for i, item in enumerate(_array(spec.get("relations"), "relations")):
        row = _mapping(item, f"relations[{i}]")
        _known_fields(row, {"id", "source", "target", "predicate", "direction", "world_scope",
                            "version_scope", "validity", "disclosure", "evidence", "status",
                            "conditions", "exceptions"}, f"relations[{i}]")
        rid = _unique_id(row, f"relations[{i}]", relation_ids)
        source, target = _id(row.get("source"), f"relation {rid}.source"), _id(row.get("target"), f"relation {rid}.target")
        predicate = _id(row.get("predicate"), f"relation {rid}.predicate")
        if source not in node_ids or target not in node_ids or predicate not in predicates:
            _fail(f"Unknown relation endpoint or predicate at {rid}")
        direction = row.get("direction")
        if direction != predicates[predicate]["direction"]:
            _fail(f"Relation {rid} direction contradicts predicate {predicate}")
        relation = {"id": rid, "source": source, "target": target, "predicate": predicate,
                          "direction": direction,
                          "world_scope": _scope(row.get("world_scope"), f"relation {rid}.world_scope"),
                          "version_scope": _scope(row.get("version_scope"), f"relation {rid}.version_scope"),
                          "validity": _validity(row.get("validity"), f"relation {rid}.validity"),
                          "disclosure": _disclosure(row.get("disclosure", _author_only_disclosure()), f"relation {rid}.disclosure"),
                          "evidence": _evidence(row.get("evidence"), f"relation {rid}.evidence", sources)}
        if "status" in row:
            relation["status"] = _text(row["status"], f"relation {rid}.status")
        for field in ("conditions", "exceptions"):
            if field in row:
                relation[field] = _qualifier(row[field], f"relation {rid}.{field}")
        relations.append(relation)
    relations.sort(key=lambda r: r["id"])
    _validate_relation_cycles(relations, predicates)

    events = []
    event_ids: set[str] = set()
    for i, item in enumerate(_array(spec.get("events"), "events")):
        row = _mapping(item, f"events[{i}]")
        _known_fields(row, {"id", "title", "participants", "world_scope", "version_scope", "validity",
                            "disclosure", "evidence", "conditions", "result", "status", "exceptions"},
                      f"events[{i}]")
        eid = _unique_id(row, f"events[{i}]", event_ids)
        participants = []
        for j, raw_person in enumerate(_array(row.get("participants"), f"event {eid}.participants")):
            person = _mapping(raw_person, f"event {eid}.participants[{j}]", {"node_id", "role"})
            node_id = _id(person.get("node_id"), f"event {eid}.participant.node_id")
            if node_id not in node_ids:
                _fail(f"Unknown participant {node_id} in event {eid}")
            participants.append({"node_id": node_id, "role": _text(person.get("role"), f"event {eid}.participant.role")})
        if len(participants) < 2:
            _fail(f"Event {eid} must have at least two participants")
        event = {"id": eid, "title": _text(row.get("title"), f"event {eid}.title"),
                 "participants": sorted(participants, key=lambda p: (p["role"], p["node_id"])),
                 "world_scope": _scope(row.get("world_scope"), f"event {eid}.world_scope"),
                 "version_scope": _scope(row.get("version_scope"), f"event {eid}.version_scope"),
                 "validity": _validity(row.get("validity"), f"event {eid}.validity"),
                 "disclosure": _disclosure(row.get("disclosure", _author_only_disclosure()), f"event {eid}.disclosure"),
                 "evidence": _evidence(row.get("evidence"), f"event {eid}.evidence", sources)}
        for field in ("conditions", "exceptions"):
            if field in row:
                event[field] = _qualifier(row[field], f"event {eid}.{field}")
        for field in ("result", "status"):
            if field in row:
                event[field] = _text(row[field], f"event {eid}.{field}")
        events.append(event)
    events.sort(key=lambda e: e["id"])

    redirects_raw = _mapping(spec.get("redirects", {}), "redirects")
    redirects = {}
    for old, new in redirects_raw.items():
        old, new = _id(old, "redirect source"), _id(new, f"redirect {old}")
        if old in node_ids:
            _fail(f"Redirect source must be a retired ID: {old}")
        redirects[old] = new
    for old in redirects:
        seen = set()
        cursor = old
        while cursor in redirects:
            if cursor in seen:
                _fail(f"Redirect cycle at {cursor}")
            seen.add(cursor)
            cursor = redirects[cursor]
        if cursor not in node_ids:
            _fail(f"Redirect chain does not resolve to a current node: {old} -> {cursor}")

    return {"schema": SCHEMA, "sources": [{k: v for k, v in row.items() if k != "_text"}
                                             for row in sorted(sources.values(), key=lambda x: x["id"])],
            "nodes": nodes, "views": views,
            "predicates": sorted(predicates.values(), key=lambda p: p["name"]),
            "relations": relations, "events": events,
            "redirects": dict(sorted(redirects.items()))}


def _at(context: dict, timeline: str, coordinate: int) -> bool:
    time = context.get("time")
    return (isinstance(time, dict) and time.get("timeline") == timeline
            and isinstance(time.get("at"), int) and not isinstance(time.get("at"), bool)
            and time["at"] >= coordinate)


def _matches_scope(allowed: list[str] | None, actual: Any) -> bool:
    return allowed is None or (actual is not None and actual in allowed)


def _record_scope_visible(record: dict, context: dict) -> bool:
    if not _matches_scope(record.get("world_scope"), context.get("world")):
        return False
    if not _matches_scope(record.get("version_scope"), context.get("version")):
        return False
    validity = record.get("validity")
    if validity is not None:
        time = context.get("time")
        if not isinstance(time, dict) or time.get("timeline") != validity["timeline"]:
            return False
        coordinate = time.get("at")
        if isinstance(coordinate, bool) or not isinstance(coordinate, int):
            return False
        if validity["from"] is not None and coordinate < validity["from"]:
            return False
        if validity["to"] is not None and coordinate > validity["to"]:
            return False
    return True


def _definition_visible(definition: dict, context: dict) -> bool:
    return (_record_scope_visible(definition, context)
            and _disclosure_visible(definition["disclosure"], context))


def _disclosure_visible(disclosure: dict, context: dict) -> bool:
    audience = context["audience"]
    if audience == "author":
        return disclosure["author"] is True
    if audience == "reader":
        reader = disclosure["reader"]
        return reader == "public" or (isinstance(reader, dict) and _at(context, reader["timeline"], reader["at"]))
    if audience == "holder":
        return _holder_access_mode(disclosure, context) is not None
    return False


def _holder_access_mode(disclosure: dict, context: dict) -> str | None:
    if context.get("audience") != "holder":
        return None
    holder_id = context.get("holder")
    for row in disclosure.get("holders", []):
        if row["id"] == holder_id and _at(context, row["timeline"], row["at"]):
            return row["mode"]
    return None


def _definition_projection(definition: dict, context: dict, include_id: bool) -> dict:
    row = {"text": definition["text"], "basis": definition["basis"], "status": definition["status"]}
    if include_id:
        row["id"] = definition["id"]
    mode = _holder_access_mode(definition["disclosure"], context)
    if mode is not None:
        row["access_mode"] = mode
    return row


def query_structure(index: dict, query: str, context: dict | None = None, limit: int = 10) -> dict:
    """Return only accessible definitions or explicitly public navigation.

    Missing context is a safe reader context. Labels and aliases have their
    own disclosure gates; hidden labels never accompany visible definitions.
    Evidence quotes are never copied into retrieval results.
    """
    index = _mapping(index, "index")
    if index.get("schema") != SCHEMA:
        _fail(f"index schema must be {SCHEMA}")
    needle = _text(query, "query").casefold()
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > 100:
        _fail("limit must be an integer from 1 through 100")
    ctx = {"audience": "reader"} if context is None or context == {} else dict(_mapping(context, "context"))
    audience = ctx.get("audience")
    if audience not in ("reader", "author", "holder"):
        _fail("context.audience must be reader, author, or holder")
    if audience == "holder" and not ctx.get("holder"):
        _fail("holder audience requires context.holder")
    if audience != "author" and ctx.get("author") is True:
        _fail("author access requires context.audience='author'")
    matches = []
    for node in index.get("nodes", []):
        visible = [d for d in node.get("definitions", []) if _definition_visible(d, ctx)]
        public_nav = node.get("public_navigation") is True
        metadata_visible = _disclosure_visible(node.get("label_disclosure", _author_only_disclosure()), ctx)
        title_visible = public_nav or metadata_visible
        aliases = [alias["text"] for alias in node.get("aliases", [])
                   if _disclosure_visible(alias.get("disclosure", _author_only_disclosure()), ctx)]
        matching_defs = [d for d in visible if needle in d["text"].casefold()]
        title_match = title_visible and needle in node["title"].casefold()
        label_match = title_match and bool(visible)
        nav_match = public_nav and title_match
        alias_match = metadata_visible and bool(visible) and any(needle in alias.casefold() for alias in aliases)
        if matching_defs or label_match or alias_match or nav_match:
            result_defs = matching_defs or (visible if label_match or alias_match else [])
            if nav_match and not result_defs:
                row = {"id": node["id"], "title": node["title"], "public_navigation": True}
            elif metadata_visible or public_nav:
                row = {"id": node["id"], "title": node["title"],
                       "definitions": [_definition_projection(d, ctx, True) for d in result_defs]}
                if metadata_visible:
                    row.update({"type": node["type"], "role": node["role"]})
            else:
                row = {"definitions": [_definition_projection(d, ctx, False) for d in result_defs]}
            if nav_match and result_defs:
                row["public_navigation"] = True
            matches.append(row)
    matches.sort(key=lambda row: (row.get("title", "").casefold(), row.get("id", ""),
                                  json.dumps(row.get("definitions", []), ensure_ascii=False, sort_keys=True)))
    matched = matches[:limit]
    matched_ids = {row["id"] for row in matched if "id" in row}
    accessible_ids = set()
    for node in index.get("nodes", []):
        if (node.get("public_navigation") is True
                or _disclosure_visible(node.get("label_disclosure", _author_only_disclosure()), ctx)):
            accessible_ids.add(node["id"])
    visible_relations = []
    for relation in index.get("relations", []):
        if (relation.get("source") in accessible_ids and relation.get("target") in accessible_ids
                and ({relation.get("source"), relation.get("target")} & matched_ids)
                and _record_scope_visible(relation, ctx)
                and _disclosure_visible(relation.get("disclosure", _author_only_disclosure()), ctx)):
            projection = {k: relation[k] for k in ("id", "source", "target", "predicate", "direction")}
            projection.update({k: relation[k] for k in ("status", "conditions", "exceptions") if k in relation})
            mode = _holder_access_mode(relation.get("disclosure", _author_only_disclosure()), ctx)
            if mode is not None:
                projection["access_mode"] = mode
            visible_relations.append(projection)
    visible_events = []
    for event in index.get("events", []):
        participant_ids = {p.get("node_id") for p in event.get("participants", [])}
        if (participant_ids <= accessible_ids and participant_ids & matched_ids
                and _record_scope_visible(event, ctx)
                and _disclosure_visible(event.get("disclosure", _author_only_disclosure()), ctx)):
            projection = {"id": event["id"], "title": event["title"], "participants": event["participants"]}
            projection.update({key: event[key] for key in ("conditions", "exceptions", "result", "status") if key in event})
            mode = _holder_access_mode(event.get("disclosure", _author_only_disclosure()), ctx)
            if mode is not None:
                projection["access_mode"] = mode
            visible_events.append(projection)
    return {"schema": SCHEMA, "results": matched,
            "relations": sorted(visible_relations, key=lambda r: r["id"]),
            "events": sorted(visible_events, key=lambda e: e["id"]), "limit": limit}
