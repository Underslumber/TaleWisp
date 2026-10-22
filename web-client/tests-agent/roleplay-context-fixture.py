"""Attach a reviewed context v2 inventory to a roleplay test spec (mirrors tests/publication/test_roleplay.py)."""
import copy
import importlib.util
import json
import sys
from pathlib import Path

context_path, project, vault = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
spec = json.loads(sys.stdin.read())
module_spec = importlib.util.spec_from_file_location("roleplay_context_fixture", context_path)
context = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(context)

source = spec["sources"][0]
fragment_units = {(source["source_id"], fragment["fragment_id"]): f"P{index:04d}" for index, fragment in enumerate(source["fragments"], 1)}
runtime_context = copy.deepcopy(spec["scene_context"])
for value in runtime_context.values():
    for entry in value if isinstance(value, list) else [value]:
        for ref in entry.get("source_refs", []) if isinstance(entry, dict) else []:
            ref["fragment_id"] = fragment_units.get((ref["source_id"], ref["fragment_id"]), ref["fragment_id"])
declarations = [(group, field, entry["value"]) for group in ("world", "hero") for field, entries in spec[group].items() for entry in entries]
constraints = [{"id": f"c{index}", "text": value} for index, (_, _, value) in enumerate(declarations, 1)]
request = {"context_version": 2, "assembly_run_id": "assembly_fixture", "allow_roleplay": True, "author_constraints": constraints,
           "read_scope": [{"source_id": source["source_id"], "path": source["path"], "first_id": "P0001", "last_id": f"P{len(source['fragments']):04d}"}],
           "runtime": {"branch_id": spec["branch_id"], "hero_id": spec["hero_id"], "series_id": spec["series_id"], "story_time": spec["story_time"],
                       "scene_context": runtime_context, "unknown_dispositions": {},
                       "staging": {key: spec["scene"][key][0]["value"] for key in ("starting_state", "time", "viewpoint", "constraints")},
                       "craft_input": spec["craft_input"], "scene_design": spec.get("scene_design", {})}}
source_packet = context.prepare_context(vault, request)["source_packet"]
units = [(s["source_id"], unit) for s in source_packet["sources"] for unit in s["units"]]
facts, coverage = [], {}
for index, (group, field, value) in enumerate(declarations, 1):
    roles = ["leader"] if group == "world" else ["leader", "hero"]
    source_id, unit = units[0]
    facts.append({"id": field, "claim": value, "status": "active", "target": f"{group}.{field}",
                  "evidence": [{"source_id": source_id, "unit_id": unit["unit_id"], "quote": unit["text"]}],
                  "author_constraint_ids": [f"c{index}"], "known_to": roles, "required_roles": roles,
                  "scene_influence": f"{field} changes what the hero can do."})
    coverage.setdefault((source_id, unit["unit_id"]), []).append(field)
inventory = {"context_version": 2, "request": request, "facts": facts,
             "unit_coverage": [{"source_id": source_id, "unit_id": unit["unit_id"], "fact_ids": coverage.get((source_id, unit["unit_id"]), [facts[0]["id"]]), "excluded_parts": []}
                               for source_id, unit in units],
             "conflicts": [], "unknowns": []}
request["runtime"]["kernel"] = [
    {"id": "hero_goal", "layer": "hero", "slot": "goal", "ref": {"fact_id": "goals"}, "holder": ["hero", "leader"]},
    {"id": "goal_tension", "layer": "scene", "slot": "tension", "ref": {"scene_context": {"field": "hero_activity"}}, "holder": ["hero", "leader"], "links": [{"rel": "informs", "to": "hero_goal"}]},
    {"id": "npc_guard", "layer": "leader", "slot": "npc", "ref": {"scene_context": {"field": "leader_only_context", "index": 0}},
     "motive_ref": {"scene_context": {"field": "leader_only_context", "index": 0}}, "access_ref": {"scene_context": {"field": "leader_only_context", "index": 0}}, "background": True},
]
inventory["role_packets"] = context.build_role_packets(inventory)
hashes = [context.canonical_sha256(x) for x in (request, source_packet, inventory, inventory["role_packets"])]
receipt = {"schema_version": 1, "run_id": "independent_fixture_review", "identity": "fixture-reviewer", "provenance": "trusted_host_review",
           "request_sha256": hashes[0], "source_packet_sha256": hashes[1], "inventory_sha256": hashes[2], "role_packets_sha256": hashes[3],
           "findings": [], "blockers": []}
receipts = project / ".talewisp/context-audits"
receipts.mkdir(parents=True, exist_ok=True)
(receipts / "audit_fixture.json").write_text(json.dumps(receipt), encoding="utf-8")
spec.update({"context_version": 2, "request": request, "inventory": inventory, "semantic_audit": {"receipt_id": "audit_fixture"}})
print(json.dumps(spec, ensure_ascii=False))
