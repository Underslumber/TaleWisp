"""Deterministic, branch-local support for TaleWisp roleplay turns.

This module does not call a model. The host must make a fresh dispatch with
only the packet returned for the selected role. Filesystem boundaries provide
organization, not OS-level access isolation.
"""
from __future__ import annotations

import hashlib
import copy
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class RoleplayError(ValueError):
    pass


ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
PLACEHOLDERS = {"todo", "tbd", "unknown", "n/a", "неизвестно", "заполнить", "позже"}
REQUIRED = {
    "world": ("rules", "limits"),
    "hero": ("traits", "motives", "goals", "knowledge"),
    "scene": ("starting_state", "time", "viewpoint", "constraints"),
}
SCENE_CONTEXT_REQUIRED = ("hero_position", "hero_activity", "hero_initial_context", "leader_only_context")
CRAFT_ROLES = ("leader", "hero", "formatter")
SCENE_DESIGN_KEYS = {
    "reader_effect", "dramatic_question", "relevance_to_hero_goal", "stakes",
    "initial_value", "possible_shift", "atmosphere",
}
LEADER_CONTRACT = (
    "Lead the scene toward a meaningful reader experience and tone. Before each beat, "
    "use the source-linked runtime.kernel as entry context, not a current-state simulator. "
    "For a significant new external change, record a separate event with cause, access, "
    "perceivers, and relevance; keep its private cause out of situation text. Check that "
    "the event is tactful and genuinely connected to the scene by semantic judgment. "
    "Use scene_design only as private, branch-local direction: connect a stimulus to an "
    "existing hero goal, its possible benefit or cost, and a meaningful value at stake. "
    "Present concrete, perceivable circumstances; after the hero acts, make consequences, "
    "new relevant information, or another participant's independent action change what is "
    "available. Resolve a meaningful immediate attempt through its result, obstacle, or limit. "
    "Keep ordinary necessary substeps together unless a meaningful obstacle requires a new "
    "hero choice; stop there and do not perform the next distinct choice for the hero. "
    "Attend to the complete literal hero_action, including every material question, action, and condition; "
    "Attend to the addressee expressed by the hero's literal words; that alone does not let an NPC perceive a private thought. "
    "do not substitute one selected question for the full turn. When an NPC makes a concession, "
    "weigh that NPC's own goal, benefit, cost or risk, and retained condition; enact any locally "
    "important limit or response in dialogue or action instead of merely repeating a deadline or "
    "narrating a private audit. Do not force rejection, threats, consent, or a monetary price. "
    "Adapt to refusal or an unexpected choice without punishment or forcing a "
    "preferred outcome. Do not repeat a static question. Build atmosphere through selected "
    "sensory details and behavior. Do not expose reader intent or scene_design to the hero, "
    "and do not turn it into world canon or a prescribed ending. NPCs cannot know the hero's "
    "private thoughts from the roleplay packet. Keep the source-backed scene_context distinct: "
    "hero_initial_context is already perceived/known by the hero; leader_only_context is for "
    "the leader and must not be revealed without an in-scene path. Each NPC acquires knowledge "
    "through their own perceivable evidence and plausible access; hidden hero feelings are not "
    "public knowledge without such evidence, and do not state a precise symptomatic guess as fact. "
    "Carried NPC memory marked "
    "historical_origin belongs to its original branch and is never current knowledge for an NPC "
    "with the same ID in this branch. A visitor cannot begin beyond "
    "a protection boundary without an established route; a chance discovery is allowed only "
    "when its cause fits the actual conditions. Separate source excerpts and branch assumptions "
    "from an NPC's assertion or a character's inference; an observable event does not prove "
    "the explanation someone gives for it. If leader text contradicts the source-backed "
    "starting context, record an issue and stop that beat instead of silently repairing it. "
    "Before using assembled context, the host checks relevant primary passages and keeps each "
    "event's actor, recipient, event time, and knowledge owner explicit; citation order is not "
    "event order. Include causes or relationships already experienced and known to the hero by "
    "entry even when the source explains them later; keep events actually future at entry out. "
    "Never guess who a pronoun refers to. If a significant antecedent lacks an "
    "established owner, reread its primary source and leave ownership unresolved if still unclear; "
    "scope unknowns to the missing fact and do not infer NPC memory. Missing host, model, or "
    "source-ledger data does not establish that an NPC is ignorant. Do not turn missing data into "
    "an NPC's unexplained withholding, evasive refusal, or audit of what the hero has been told. "
    "Use the prepared positive content and answer the hero's attempt with a concrete response shaped "
    "by that NPC's established goals and actual conditions; do not invent a motive for withholding. "
    "Use response_context as a selected projection of existing leader memory, preserving each NPC owner "
    "and each heard line's speaker and recipient. For every material question, separate substantive "
    "knowledge available to the addressed NPC from the precise unknown part, then answer from that "
    "knowledge. An unknown outcome does not erase known causes or risks. Choose whether to disclose, "
    "dispute, withhold, or defer from the NPC's established motives and present situation; withholding "
    "or deferring needs an established reason, not missing host data. Before a concession, weigh the "
    "NPC's goal, current pressure, actual alternatives, immediate and deferred costs, and likely "
    "consequences. This is internal scene reasoning, not a required answer format or new audit record. "
    "Treat an NPC's self-report as "
    "that character's claim, not verified world fact; do not invent the converse by giving the NPC "
    "detailed knowledge that no source, perception, or plausible access establishes. Keep each active "
    "NPC's own goal, pressure, deadline, and limits on trusted alternatives in play until a cause is "
    "actually played that changes them. Evaluate a concession through that NPC's own interest, cost, "
    "or constraint; do not let counseling, refusal, or a convenient exchange erase the pressure without "
    "a played cause. This does not require threats, sarcasm, or a fixed outcome. Maintain current_hero_state separately "
    "from entry context: after a hero action it is unresolved until the physical outcome is "
    "explicitly resolved. Record a full position and activity with set_hero_state or on the "
    "situation/consequence; distinguish completed ordinary motion from blocked or unknown outcome. "
    "Treat weather as neutral and uneventful unless the supplied context or author explicitly "
    "establishes a weather condition or phenomenon. After each hero attempt, identify its "
    "immediate aim, relevant constraints, available means, knowledge, and any chosen speech, "
    "disclosure, or status. Resolve each attempt with a concrete result, obstacle, or limit. "
    "Add a perceived fact when it changes available means, estimated cost, or manner; do not "
    "repeat a static question or invent an observation just to move a small physical attempt. "
    "Resolve the attempt, including its physical execution, refusal, or failure, through a "
    "causal response or obstacle instead of skipping to a convenient outcome. Let each NPC "
    "respond from what they perceive and "
    "their own current purpose, established motives, and relationship habits, including socially "
    "plausible reactions to the hero's age, voice, or status when relevant. NPCs may make their "
    "own decisions, offers, or limits that create the hero's next choice; do not force them into "
    "passivity or repeat an offer by default, though purposeful repetition is allowed. Do not make "
    "them therapists or default to forgiveness or absolution. Ask whether changing or removing "
    "this hero action would "
    "change the outcome. Independent events may still happen, but must not repeatedly replace "
    "the hero's agency. Keep a short frame short by limiting scope, not by prescribing how many "
    "choices occur or forcing closure. End only after a meaningful result or decision has been "
    "played; if the scene remains unresolved, say explicitly that it is incomplete and what "
    "decision or result remains unplayed. If the hero seeks or adapts an ordinary means, "
    "resolve actual access or acquisition and fit to the hero's body and the material; do not "
    "grant inventory or abilities by fiat; resolve the attempt from those conditions."
)
HERO_CONTRACT = (
    "Strive to survive and pursue this character's own established goals within the current "
    "context and available knowledge; choose the immediate goal from that position. This "
    "does not override the character or require the safest available choice. Preserve an established "
    "form of address and social register with each person until a motivated change is actually played. "
    "This does not require obedience, agreement, or any specific outcome. "
    "Use the semantic kernel only as source-backed entry context; later observations and "
    "consequences govern current conditions. Respond naturally to what is actually perceived; "
    "Let the chosen manner follow what the character perceives and what it means to them, shaped by "
    "their current motives and self-image. This may guide action internally; do not require a narrated "
    "appraisal or expressive gesture. Remorse or change is possible when grounded, never a required "
    "endpoint; do not script confession or moral re-evaluation. "
    "Use screenwriting craft only as an external clarity check: when relevant, show what the "
    "hero perceives, what it means personally, an emotion or restrained bodily/thought "
    "response that fits this character, and a concrete attempted action with its manner or "
    "purpose. Risk should have an available personal benefit, necessity, or established "
    "impulse; consider safer available means without being required to choose the safest. "
    "Do not impose a personality, mood, moral lesson, heroic choice, danger, or emotional "
    "gesture each turn. Do not claim an attempt succeeded or use information the hero has "
    "not received. The hero may question, inspect, or challenge an apparently impossible claim; "
    "do not require acceptance of leader framing. Use current_hero_state only when its scope says "
    "resolved; unresolved or unknown means entry posture is historical, not current. Craft examples are writing guidance, never "
    "facts, memories, or knowledge belonging to this hero. Translate relevant constraints, "
    "knowledge, resources, and personal goals into the choice that fits this situation. Speech, "
    "disclosure, use of status, and choice of means are actions with possible consequences; "
    "evaluate them in context without requiring any particular form, extra explanation, or "
    "preset result. Before committing words or movement, briefly and quietly compare the proposed action with "
    "enabling conditions of relevant resources or protections that the hero actually knows from "
    "available perception and knowledge. If the action may defeat a known useful condition, consider "
    "what benefit could be lost and whether the choice follows a local benefit, necessity, an "
    "established character impulse, or a plausible mistake from limited knowledge or perception. "
    "The hero need not anticipate every cost or reason perfectly. For example, disclosing something "
    "known to be useful only while unknown can spend that advantage, but may still be chosen on a "
    "grounded basis. Unknown conditions create no duty to anticipate them. This brief check does not "
    "require narrated analysis, a ledger, or an explanation format. Ordinary means need not be "
    "pre-listed in inventory: the hero may seek or adapt what is plausibly accessible, considering "
    "their body and the material. Do not assume access, grant equipment or abilities, or claim "
    "success; the leader resolves the attempt."
)
FORMATTER_CONTRACT = (
    "Preserve every accepted action, motive, knowledge boundary, and consequence, including "
    "the safe observed event and stimulus trace where present. Never expose private event "
    "causes, access records, unplayed kernel entries, or leader-only information. Preserve "
    "the hero's played perception, personal meaning, emotion or restraint, bodily response, "
    "and manner of execution contained in the action text. Do not reduce these to plot beats "
    "or dialogue alone, and do not invent unplayed experience. Format only; do not add, "
    "remove, or reorder events. When shortening, keep the earned experience that explains the "
    "hero's choice and preserves its emotional or bodily consequence. Craft examples are "
    "guidance only, not scene facts."
)
HOST_REVIEW_CHECKLIST = (
    "Before delivering the current hero attempt to the leader for a response, first check whether "
    "its words or movements contradict an enabling condition of a relevant resource or protection "
    "that was actually known to the hero from available perception and knowledge. Do not apply "
    "conditions the hero could not know. A resource useful only while unknown is a general example: "
    "disclosing it may spend that advantage. The basis for the action may be a concrete local benefit, "
    "necessity, an established character impulse, or a plausible mistake grounded in the hero's "
    "available perception or knowledge. The hero need not anticipate the cost; do not demand perfect "
    "rationality or the safest action. Reject only an ungrounded contradiction, not a bad result: in "
    "that case record an issue with the issue action and pause before leader resolution. Preserve the "
    "hero's literal attempt: do not rewrite it or invent a motive. Do not require a verbose ledger or "
    "special justification field. Before relying on assembled context, check the relevant primary "
    "passages and keep each significant event's actor, recipient, event time, and knowledge owner explicit; "
    "never guess a pronoun's referent. If a significant antecedent has no established owner, reread the "
    "source and leave that fact unresolved if still unclear; scope the unknown to that gap and do not infer "
    "NPC memory. Include in hero entry causes or relationships already experienced and known by that "
    "time even when the source explains them later; exclude events that are future at entry. Treat "
    "context selection as a semantic host judgment: inspect each relevant source unit and either "
    "include its scene-relevant personality, relationship, cause, or constraint, or record a "
    "content-specific reason why excluding it loses none of those. Dialogue, hesitation, jokes, "
    "vanity, defensiveness, and apparently minor exchanges may be key evidence; do not discard "
    "them under a blanket label such as atmosphere or redundancy. Unknown or unmapped units need "
    "review and must not default to atmosphere. Retain short exact pre-entry speech with speaker, "
    "recipient, and personal context; labels such as sharp or flirtatious are not enough. Keep "
    "leader-only hero-private facts available for host adjudication while separating what each NPC "
    "actually knows; exclude future author answers. Do not convert source audits or private facts "
    "into NPC dialogue. This is a semantic host workflow, not an automatic semantic validator. "
    "Before dispatch, record each material unresolved context gap in host-side context_gaps; an "
    "unresolved gap blocks both actor inputs and is explained only in the host exception. A resolved "
    "gap needs a positive fact, rationale and source evidence, plus exact bindings to existing literal "
    "positive facts in the role memories that need it. A branch resolution requires exact explicit "
    "authorization for noncanon staging; source-first resolution takes priority. These records are "
    "host data and never enter actor payloads. Structural checks do not prove that gap analysis is "
    "complete or that a source interpretation is true. Do not turn missing host, model, or source "
    "data into NPC dialogue about the missing data, an evasive refusal, or an audit of what has been "
    "said. Have the leader answer the attempt with a concrete action shaped by established goals and "
    "conditions; do not read the ledger aloud. Preserve established goals and pressure without "
    "requiring threats or consent. "
    "Check that missing host, model, or source-ledger data has not been turned into NPC ignorance; "
    "keep an NPC's self-report attributed as a claim rather than verified world fact, and do not "
    "invent detailed knowledge in the other direction. Check the hero's address and social register "
    "against established relationship evidence and preserve it unless a motivated change is played. "
    "Treat unobserved hero feelings as private; require perceivable evidence before an NPC "
    "knows them, and never state a precise symptom inferred from hidden input as fact. Then, before accepting "
    "each leader exchange, review: (1) what perceived stimulus and current personal goal caused the attempt, "
    "and did it receive a concrete result, obstacle, or limit? Keep ordinary necessary substeps together "
    "unless a meaningful obstacle requires a new hero choice; do not perform that next choice for them. Add "
    "a perceived fact when it changes available means, estimated cost, or manner; do not invent an observation "
    "for a small physical attempt. (2) is the chosen speech, disclosure, or social position locally grounded "
    "in the hero's body, resources, knowledge, motives, current self-image, and relationship habits? Remorse "
    "or change may occur when grounded but is not a required endpoint. Orders, apologies, and ordinary "
    "politeness remain allowed when earned; do not prescribe aggression or an emotional performance. (3) "
    "what did each NPC actually hear or see, and does their response follow their own current purpose, "
    "interests, and established relationship habits? NPCs may make decisions, offers, or limits that shape "
    "the next choice; do not force passivity or repeat offers by default, though purposeful repetition is "
    "allowed. No compulsory therapy or forgiveness. Check that each active NPC's goal, pressure, "
    "deadline, and trusted alternatives remain active until a played cause changes them; assess each "
    "concession through the NPC's own interest, cost, or constraint, without requiring threats, sarcasm, "
    "or consent. (4) was the actual attempt "
    "resolved, including physical execution, refusal, or failure, and would changing or removing it "
    "change anything? Independent events are allowed, but repeated replacement of agency is not. "
    "(5) are observation, inference, and reported claim distinct, with private motives kept from hero "
    "knowledge? (6) is weather neutral unless the context or author added a condition? (7) has a "
    "meaningful result or decision been played, or is the scene explicitly incomplete with what "
    "remains unresolved, rather than ending on a list of future options? This is semantic host review, "
    "not automatic text validation. Also compare the complete literal hero_action with the intake and "
    "actual scene: account for every material question, action, and condition; do not treat contiguous "
    "character spans as proof of semantic completeness. For a significant NPC decision or concession, "
    "check its stated goal, benefit, cost or risk, retained condition, action evidence, and local scene "
    "evidence against the actual scene; private rationale alone does not prove the choice was enacted. "
    "The diagnostic list may be empty when the scene claims no such decision."
)
PROBE_BRIEFS = [
    {"probe_id": "choice_under_pressure", "title": "Выбор под давлением",
     "brief": "Возьми только уже установленную цель, ценность или отношение героя и реальный риск, подтверждённый правилами мира. Поставь выбор между продвижением этой цели и риском. Если подходящей связи или риска в источниках нет, отметь пробел; не добавляй близкого человека, отношение или опасность."},
    {"probe_id": "motive_conflict", "title": "Конфликт мотивов",
     "brief": "Используй две уже подтверждённые и конкурирующие цели, ценности или отношения героя. Спроси, чему он отдаёт приоритет в текущей ситуации. Если подтверждённого конфликта нет, отметь пробел вместо того, чтобы придумывать мотив или обязательство."},
]


def _hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _semantics():
    import importlib.util
    path = Path(__file__).with_name("roleplay_semantics.py")
    spec = importlib.util.spec_from_file_location("talewisp_roleplay_semantics", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _project_branch_kernel(state: dict[str, Any], role: str) -> list[dict[str, Any]]:
    suppressed=set()
    if role=="hero":
        changed={f"hero.{k}" for k in state.get("accepted_character_deltas",{})}
        index=state.get("fact_target_index") or {}
        suppressed={fid for fid,target in index.items() if target in changed}
    packets=state.get("role_context_packets") or {}
    facts=[]
    roles=("hero",) if role=="hero" else ("leader",)
    for packet in (packets.get(r) for r in roles):
        if isinstance(packet,list): facts.extend(x for x in packet if isinstance(x,dict) and x.get("fact_id"))
    hero_ids=set(state.get("hero_kernel_fact_ids",[]))
    if role=="hero": facts=[x for x in facts if x.get("fact_id") in hero_ids and x.get("status")=="active" and "hero" in x.get("known_to",[])]
    inventory={"facts":[{"id":x.get("fact_id"),"claim":x.get("claim",x.get("text")),"status":"active",
                         "known_to":["hero"],"required_roles":["hero"]} for x in facts]}
    return _semantics().project_kernel(state.get("kernel",[]), role, inventory=inventory,
        scene_context=state.get("scene_context",{}), unknowns=state.get("unknowns",[]), suppressed_fact_ids=suppressed)


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise RoleplayError(f"Invalid {label}; use 1-64 letters, digits, '_' or '-' and start with a letter or digit")
    return value


def _text(value: Any, label: str, *, minimum: int = 3) -> str:
    if not isinstance(value, str) or len(value.strip()) < minimum:
        raise RoleplayError(f"{label} must contain at least {minimum} non-whitespace characters")
    normalized = value.strip()
    folded = normalized.casefold()
    if folded in PLACEHOLDERS or re.match(r"^(?:todo|tbd|unknown|n/?a|неизвестно|заполнить|позже)(?:\b|\s*[:—-])", folded):
        raise RoleplayError(f"{label} is a placeholder")
    return normalized


def _paths(project_root: Path, vault_root: Path, session_id: str) -> tuple[Path, Path, Path]:
    project = Path(project_root).expanduser().resolve()
    vault = Path(vault_root).expanduser().resolve()
    if not project.is_dir() or not vault.is_dir():
        raise RoleplayError("Project and active vault must exist")
    sid = _identifier(session_id, "session_id")
    base = project / ".talewisp" / "roleplay"
    target = base / f"{sid}.json"
    for path in (project / ".talewisp", base, target):
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            raise RoleplayError("Roleplay state cannot use a symlink or junction")
        if not path.resolve(strict=False).is_relative_to(project):
            raise RoleplayError("Roleplay state path escapes the project")
    return project, vault, target


def _source_catalog(vault: Path, sources: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(sources, list) or not sources:
        raise RoleplayError("At least one source fragment is required")
    catalog: dict[str, dict[str, Any]] = {}
    for item in sources:
        if not isinstance(item, dict):
            raise RoleplayError("Each source must be an object")
        source_id = _identifier(item.get("source_id"), "source_id")
        rel = item.get("path")
        if not isinstance(rel, str) or not rel.strip() or Path(rel).is_absolute() or ".." in Path(rel).parts:
            raise RoleplayError(f"Source {source_id} path must be vault-relative")
        unresolved = vault / rel
        if any(p.is_symlink() or (hasattr(p, "is_junction") and p.is_junction()) for p in (unresolved, *unresolved.parents) if p != vault.parent):
            raise RoleplayError(f"Source {source_id} cannot use a symlink or junction")
        path = unresolved.resolve()
        if not path.is_relative_to(vault) or not path.is_file():
            raise RoleplayError(f"Source {source_id} is missing or outside the active vault")
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise RoleplayError(f"Cannot read source {source_id}: {exc}") from exc
        digest = item.get("sha256")
        if not isinstance(digest, str) or digest != _hash(raw):
            raise RoleplayError(f"Source hash is missing or stale: {source_id}")
        fragments = item.get("fragments")
        if not isinstance(fragments, list) or not fragments:
            raise RoleplayError(f"Source {source_id} has no declared fragments")
        decoded = raw.decode("utf-8")
        by_id: dict[str, str] = {}
        for fragment in fragments:
            if not isinstance(fragment, dict):
                raise RoleplayError("Source fragment must be an object")
            fid = _identifier(fragment.get("fragment_id"), "fragment_id")
            quote = _text(fragment.get("quote"), "source quote", minimum=8)
            if quote not in decoded:
                raise RoleplayError(f"Source fragment {source_id}/{fid} does not match the current source")
            if fid in by_id:
                raise RoleplayError(f"Duplicate fragment id in source {source_id}: {fid}")
            by_id[fid] = quote
        catalog[source_id] = {"path": rel, "sha256": digest, "fragments": by_id}
    return catalog


def _declarations(vault: Path, spec: dict[str, Any], catalog: dict[str, dict[str, Any]]) -> dict[str, dict[str, list[str]]]:
    coverage: dict[str, dict[str, list[str]]] = {}
    for group, fields in REQUIRED.items():
        values = spec.get(group)
        if not isinstance(values, dict):
            raise RoleplayError(f"{group} declarations are required")
        coverage[group] = {}
        for field in fields:
            entries = values.get(field)
            if field in ("starting_state", "time", "viewpoint"):
                entries = entries if isinstance(entries, list) else [entries]
            if not isinstance(entries, list) or not entries:
                raise RoleplayError(f"At least one evidenced declaration is required for {group}.{field}")
            seen_refs: list[str] = []
            for idx, entry in enumerate(entries):
                if isinstance(entry, str):
                    entry = {"value": entry}
                if not isinstance(entry, dict):
                    raise RoleplayError(f"Invalid declaration {group}.{field}[{idx}]")
                if "branch_assumption" in entry:
                    raise RoleplayError("branch_assumption is allowed only inside scene_context")
                _text(entry.get("value"), f"{group}.{field}[{idx}]")
                refs = entry.get("source_refs", [])
                instruction = entry.get("author_instruction")
                if not isinstance(refs, list) or (not refs and not isinstance(instruction, str)):
                    raise RoleplayError(f"Declaration {group}.{field}[{idx}] needs source_refs or exact author_instruction provenance")
                if instruction is not None:
                    _text(instruction, f"author_instruction for {group}.{field}[{idx}]")
                    seen_refs.append("author_instruction")
                for ref in refs:
                    if not isinstance(ref, dict):
                        raise RoleplayError("source_refs entries must be objects")
                    sid = _identifier(ref.get("source_id"), "source_id")
                    fid = _identifier(ref.get("fragment_id"), "fragment_id")
                    if sid not in catalog or fid not in catalog[sid]["fragments"]:
                        raise RoleplayError(f"Unknown source fragment for {group}.{field}: {sid}/{fid}")
                    seen_refs.append(f"{sid}#{fid}")
            coverage[group][field] = sorted(set(seen_refs))
    return coverage


def readiness(project_root: Path, vault_root: Path, spec: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(spec, dict):
        raise RoleplayError("readiness spec must be an object")
    if spec.get("context_version") == 2:
        path = Path(__file__).with_name("roleplay_context.py")
        import importlib.util
        module_spec = importlib.util.spec_from_file_location("talewisp_roleplay_context", path)
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        try:
            result = module.check_context(vault_root, spec["request"], spec["inventory"], spec.get("semantic_audit"), project_root)
        except (module.ContextError, KeyError, TypeError) as exc:
            raise RoleplayError(str(exc)) from exc
        runtime = spec["request"].get("runtime")
        concrete = False
        runtime_coverage, runtime_errors = {}, ["Concrete runtime staging is not specified"]
        if isinstance(runtime, dict):
            try:
                for field in ("branch_id", "hero_id", "series_id"):
                    _identifier(runtime.get(field), field)
                if not isinstance(runtime.get("story_time"), dict):
                    raise RoleplayError("Runtime story_time is required")
                _identifier(runtime["story_time"].get("id"), "story_time.id")
                _text(runtime["story_time"].get("label"), "story_time.label")
                staging = runtime.get("staging")
                if not isinstance(staging, dict) or any(not isinstance(staging.get(k), str) or len(staging[k].strip()) < 3 for k in ("starting_state", "time", "viewpoint", "constraints")):
                    raise RoleplayError("Concrete runtime staging needs starting_state, time, viewpoint, and constraints")
                packet = result["source_packet"]
                catalog = {s["source_id"]: {"path": s["path"], "sha256": s["sha256"],
                           "fragments": {u["unit_id"]: u["text"] for u in s["units"]}} for s in packet["sources"]}
                normalized_context, runtime_coverage, runtime_errors = _scene_context(runtime.get("scene_context"), catalog, allow_missing=True)
                runtime_errors.extend(_unknown_disposition_errors(
                    spec["inventory"].get("unknowns", []), runtime, normalized_context))
                try:
                    _semantics().validate_kernel(runtime.get("kernel"), spec["inventory"], normalized_context)
                except ValueError as exc:
                    runtime_errors.append(str(exc))
                concrete = not runtime_errors
            except RoleplayError:
                concrete = False
        return {"context_version": 2, **result, "declaration_complete": result["structural_complete"],
                "scene_context_complete": concrete, "scene_context_source_coverage": runtime_coverage,
                "scene_context_issues": runtime_errors,
                "concrete_context_complete": concrete,
                "offerable": bool(result["analysis_ready"] and spec["request"].get("allow_roleplay") is True and concrete),
                "legacy_branch_compatible": True}
    _scene_design(spec.get("scene_design", {}))
    for field in ("branch_id", "hero_id", "series_id"):
        _identifier(spec.get(field), field)
    story_time = spec.get("story_time")
    if not isinstance(story_time, dict) or not isinstance(story_time.get("id"), str) or not story_time.get("id", "").strip():
        raise RoleplayError("story_time binding with a stable id is required")
    _text(story_time.get("label"), "story_time.label")
    if not isinstance(spec.get("semantic_review"), dict):
        raise RoleplayError("semantic_review declaration is required")
    review = spec["semantic_review"]
    review_status = review.get("status")
    if review_status not in {"unreviewed", "source_reviewed", "author_confirmed"}:
        raise RoleplayError("semantic_review.status must be unreviewed, source_reviewed, or author_confirmed")
    vault = Path(vault_root).expanduser().resolve()
    project = Path(project_root).expanduser().resolve()
    if not vault.is_dir() or not project.is_dir():
        raise RoleplayError("Project and active vault must exist")
    catalog = _source_catalog(vault, spec.get("sources"))
    coverage = _declarations(vault, spec, catalog)
    _, context_coverage, context_errors = _scene_context(spec.get("scene_context"), catalog, allow_missing=True)
    complete = True
    result = {
        "branch_id": spec["branch_id"], "hero_id": spec["hero_id"], "series_id": spec["series_id"],
        "story_time": spec["story_time"], "declaration_complete": complete,
        "source_fragments_match_current_hashes": True,
        "field_source_coverage": coverage,
        "scene_context_complete": not context_errors,
        "scene_context_source_coverage": context_coverage,
        "scene_context_issues": context_errors,
        "semantic_review": {"status": review_status, "reviewer": review.get("reviewer"),
                            "self_reported": True, "independently_verified": False},
        "offerable": False,
        "readiness_status": "needs_context_audit",
        "limitation": "Legacy declaration specs remain readable but cannot establish source-first completeness or authorize a new branch. Build a current bounded context inventory and independent semantic audit.",
    }
    return result


def _load(target: Path) -> dict[str, Any]:
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RoleplayError("Roleplay branch does not exist") from exc
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RoleplayError(f"Cannot read roleplay branch: {exc}") from exc
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise RoleplayError("Invalid roleplay branch schema")
    # Schema 1 branches written before past-scene projection have no such
    # field. Treat them as empty history without rewriting on a read.
    data.setdefault("past_hero_experience", [])
    data.setdefault("scene_design", {})
    data.setdefault("scene_context", {})
    data.setdefault("source_excerpts", [])
    data.setdefault("craft_input", {})
    # Older branches have no recorded present-state checkpoint. Never derive a
    # current pose from their entry context or prose history.
    data.setdefault("current_hero_state", None)
    data.setdefault("current_hero_state_status", "unknown")
    data.setdefault("hero_state_history", [])
    return data


def _save(target: Path, data: dict[str, Any]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    fd, temp_name = tempfile.mkstemp(prefix=".roleplay-", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, target)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def _safe_spec(vault: Path, spec: dict[str, Any]) -> dict[str, Any]:
    catalog = _source_catalog(vault, spec["sources"])
    _declarations(vault, spec, catalog)
    context, _, _ = _scene_context(spec.get("scene_context"), catalog)
    craft_input = _craft_input(spec.get("craft_input", {}))
    # Only exact, declared fragments are retained for leader review. Full source
    # documents are never copied into roleplay state.
    refs = set()
    for group in ("world", "hero", "scene"):
        for entries in spec[group].values():
            for entry in entries if isinstance(entries, list) else [entries]:
                if isinstance(entry, dict):
                    refs.update((ref["source_id"], ref["fragment_id"]) for ref in entry.get("source_refs", []))
    for key in SCENE_CONTEXT_REQUIRED:
        entries = context[key] if isinstance(context[key], list) else [context[key]]
        for entry in entries:
            refs.update((ref["source_id"], ref["fragment_id"]) for ref in entry.get("source_refs", []))
    excerpts = [{"source_id": sid, "fragment_id": fid, "text": catalog[sid]["fragments"][fid]}
                for sid, fid in sorted(refs)]
    return {"branch_id": spec["branch_id"], "hero_id": spec["hero_id"], "series_id": spec["series_id"],
            "story_time": copy.deepcopy(spec["story_time"]), "world": copy.deepcopy(spec["world"]),
            "hero": copy.deepcopy(spec["hero"]), "scene": copy.deepcopy(spec["scene"]),
            "scene_context": context, "source_excerpts": excerpts, "craft_input": craft_input,
            "scene_design": copy.deepcopy(_scene_design(spec.get("scene_design", {}))),
            "sources": [{"source_id": s["source_id"], "path": s["path"], "sha256": s["sha256"]} for s in spec["sources"]],
            "semantic_review": spec["semantic_review"]}


def _safe_spec_v2(vault: Path, request: dict[str, Any], inventory: dict[str, Any], readiness_result: dict[str, Any]) -> dict[str, Any]:
    """Normalize active inventory facts directly; never copy manual world/hero summaries."""
    runtime = request.get("runtime")
    if not isinstance(runtime, dict):
        raise RoleplayError("Concrete runtime staging is required to start")
    packet = readiness_result["source_packet"]
    context_path = Path(__file__).with_name("roleplay_context.py")
    import importlib.util
    context_spec = importlib.util.spec_from_file_location("talewisp_roleplay_context", context_path)
    context_module = importlib.util.module_from_spec(context_spec)
    context_spec.loader.exec_module(context_module)
    catalog = {s["source_id"]: {"path": s["path"], "sha256": s["sha256"],
               "fragments": {u["unit_id"]: u["text"] for u in s["units"]}} for s in packet["sources"]}
    world = {"rules": [], "limits": []}
    hero = {"traits": [], "motives": [], "goals": [], "knowledge": []}
    fact_target_index = {}
    for fact in inventory.get("facts", []):
        target = context_module.resolve_fact_target(fact)
        fact_target_index[fact["id"]] = target
        if fact.get("status") != "active":
            continue
        group, field = target.split(".")
        refs, author_instruction = [], None
        for evidence in fact.get("evidence", []):
            refs.append({"source_id": evidence["source_id"], "fragment_id": evidence["unit_id"]})
        if not refs and fact.get("author_constraint_ids"):
            constraints = {c["id"]: c["text"] for c in request.get("author_constraints", [])}
            author_instruction = " ".join(constraints[cid] for cid in fact["author_constraint_ids"])
        declaration = {"value": fact["claim"], "source_refs": refs}
        if author_instruction:
            declaration["author_instruction"] = author_instruction
        (world if group == "world" else hero)[field].append(declaration)
    context, _, errors = _scene_context(runtime.get("scene_context"), catalog)
    if errors:
        raise RoleplayError("Concrete source-backed runtime scene_context is required")
    staging = runtime["staging"]
    semantic = _semantics()
    kernel = semantic.validate_kernel(runtime.get("kernel"), inventory, context)
    scene = {field: [{"value": staging[field], "author_instruction": staging[field]}]
             for field in ("starting_state", "time", "viewpoint", "constraints")}
    _text(runtime["story_time"].get("label"), "story_time.label")
    _identifier(runtime["branch_id"], "branch_id"); _identifier(runtime["hero_id"], "hero_id"); _identifier(runtime["series_id"], "series_id")
    return {"branch_id": runtime["branch_id"], "hero_id": runtime["hero_id"], "series_id": runtime["series_id"],
            "story_time": copy.deepcopy(runtime["story_time"]), "world": world, "hero": hero, "scene": scene,
            "scene_context": context, "source_excerpts": [{"source_id": s["source_id"], "fragment_id": u["unit_id"], "text": u["text"]}
                                for s in packet["sources"] for u in s["units"]],
            "craft_input": _craft_input(runtime.get("craft_input", {})),
            "scene_design": _scene_design(runtime.get("scene_design", {})),
            "sources": [{"source_id": s["source_id"], "path": s["path"], "sha256": s["sha256"]} for s in packet["sources"]],
            "semantic_review": {"status": "trusted_host_review", "reviewer": readiness_result.get("audit_provenance")},
            "role_context_packets": inventory["role_packets"],
            "kernel": kernel,
            "unknowns": copy.deepcopy(inventory.get("unknowns", [])),
            "hero_kernel_fact_ids": sorted(f["id"] for f in inventory.get("facts", [])
                if f.get("status") == "active" and "hero" in f.get("known_to", []) and "hero" in f.get("required_roles", [])),
            "fact_target_index": fact_target_index,
            "context_hashes": {"source_packet_sha256": readiness_result["source_packet_sha256"],
                               "inventory_sha256": readiness_result["inventory_sha256"],
                               "role_packets_sha256": readiness_result["role_packets_sha256"]}}


def _scene_context(value: Any, catalog: dict[str, dict[str, Any]], *, allow_missing: bool = False) -> tuple[dict[str, Any], dict[str, list[str]], list[str]]:
    """Validate the source-backed starting state and keep hero/leader knowledge distinct."""
    if value is None and allow_missing:
        return {}, {}, ["scene_context is required for a new roleplay branch"]
    if not isinstance(value, dict):
        raise RoleplayError("scene_context must be an object")
    unknown = set(value) - set(SCENE_CONTEXT_REQUIRED)
    if unknown:
        raise RoleplayError(f"Unknown scene_context keys: {', '.join(sorted(map(str, unknown)))}")
    errors = [f"scene_context.{field} is required" for field in SCENE_CONTEXT_REQUIRED if field not in value]
    result: dict[str, Any] = {}
    coverage: dict[str, list[str]] = {}
    for field in SCENE_CONTEXT_REQUIRED:
        if field not in value:
            continue
        entries = value[field] if field in ("hero_initial_context", "leader_only_context") else [value[field]]
        if not isinstance(entries, list) or not entries:
            errors.append(f"scene_context.{field} needs at least one declaration")
            continue
        normalized = []
        seen = []
        for index, entry in enumerate(entries):
            if isinstance(entry, str):
                entry = {"value": entry}
            if not isinstance(entry, dict):
                raise RoleplayError(f"Invalid scene_context.{field}[{index}]")
            unknown_claim_keys = set(entry) - {"value", "source_refs", "author_instruction", "branch_assumption"}
            if unknown_claim_keys:
                raise RoleplayError(
                    f"Unknown scene_context.{field}[{index}] keys: {', '.join(sorted(map(str, unknown_claim_keys)))}")
            text = _text(entry.get("value"), f"scene_context.{field}[{index}]")
            refs = entry.get("source_refs", [])
            instruction = entry.get("author_instruction")
            assumption = entry.get("branch_assumption")
            if not isinstance(refs, list) or (not refs and not isinstance(instruction, str) and not isinstance(assumption, str)):
                raise RoleplayError(f"scene_context.{field}[{index}] needs source_refs, author_instruction, or branch_assumption provenance")
            claim = {"value": text}
            if instruction is not None:
                claim["author_instruction"] = _text(instruction, f"author_instruction for scene_context.{field}[{index}]")
                seen.append("author_instruction")
            if assumption is not None:
                claim["branch_assumption"] = _text(assumption, f"branch_assumption for scene_context.{field}[{index}]")
                seen.append("branch_assumption")
            checked_refs = []
            for ref in refs:
                if not isinstance(ref, dict):
                    raise RoleplayError("scene_context source_refs entries must be objects")
                sid = _identifier(ref.get("source_id"), "source_id")
                fid = _identifier(ref.get("fragment_id"), "fragment_id")
                if sid not in catalog or fid not in catalog[sid]["fragments"]:
                    raise RoleplayError(f"Unknown source fragment for scene_context.{field}: {sid}/{fid}")
                checked_refs.append({"source_id": sid, "fragment_id": fid})
                seen.append(f"{sid}#{fid}")
            if checked_refs:
                claim["source_refs"] = checked_refs
            normalized.append(claim)
        result[field] = normalized if field in ("hero_initial_context", "leader_only_context") else normalized[0]
        coverage[field] = sorted(set(seen))
    if errors and not allow_missing:
        raise RoleplayError("Incomplete scene_context: " + "; ".join(errors))
    return result, coverage, errors


def _unknown_disposition_errors(unknowns: Any, runtime: dict[str, Any], scene_context: Any) -> list[str]:
    """Validate exact, request-bound dispositions for every declared unknown."""
    errors = []
    if not isinstance(unknowns, list) or not isinstance(runtime.get("unknown_dispositions"), dict):
        return ["runtime.unknown_dispositions must map every inventory unknown ID"]
    dispositions = runtime["unknown_dispositions"]
    ids = [item.get("id") for item in unknowns if isinstance(item, dict)]
    if len(ids) != len(unknowns) or len(ids) != len(set(ids)):
        return ["Inventory unknown IDs must be present and unique"]
    if set(dispositions) != set(ids):
        errors.append("runtime.unknown_dispositions must contain exactly the inventory unknown IDs")
    if not isinstance(scene_context, dict):
        scene_context = {}
    arrays = {"hero_initial_context", "leader_only_context"}
    scalars = {"hero_position", "hero_activity"}
    for unknown_id in ids:
        item = dispositions.get(unknown_id)
        if not isinstance(item, dict):
            errors.append(f"Unknown {unknown_id} needs a disposition record")
            continue
        kind = item.get("status")
        if kind == "blocks_start":
            if set(item) != {"status"}:
                errors.append(f"Unknown {unknown_id} blocks_start accepts only status")
            errors.append(f"Unknown {unknown_id} blocks roleplay start")
        elif kind == "not_required":
            reason = item.get("reason")
            if set(item) != {"status", "reason"} or not isinstance(reason, str) or len(reason.strip()) < 3:
                errors.append(f"Unknown {unknown_id} not_required needs a concrete reason")
        elif kind == "resolved":
            refs = item.get("scene_context_refs")
            if set(item) != {"status", "scene_context_refs"} or not isinstance(refs, list) or not refs:
                errors.append(f"Unknown {unknown_id} resolved needs scene_context_refs")
                continue
            for ref in refs:
                if not isinstance(ref, dict) or set(ref) - {"field", "index"}:
                    errors.append(f"Unknown {unknown_id} has a malformed scene_context reference")
                    continue
                field = ref.get("field")
                if field in scalars:
                    valid = set(ref) == {"field"} and field in scene_context
                elif field in arrays:
                    index = ref.get("index")
                    valid = (set(ref) == {"field", "index"} and isinstance(index, int) and not isinstance(index, bool)
                             and index >= 0 and isinstance(scene_context.get(field), list)
                             and index < len(scene_context[field]))
                else:
                    valid = False
                if not valid:
                    errors.append(f"Unknown {unknown_id} references a missing or invalid scene_context declaration")
        else:
            errors.append(f"Unknown {unknown_id} status must be blocks_start, not_required, or resolved")
    return errors


def _craft_input(value: Any) -> dict[str, list[str]]:
    """Keep author-provided craft guidance separate from story facts and memory."""
    if not isinstance(value, dict) or set(value) - set(CRAFT_ROLES):
        raise RoleplayError("craft_input must contain only leader, hero, or formatter guidance")
    result = {}
    for role, items in value.items():
        if not isinstance(items, list):
            raise RoleplayError(f"craft_input.{role} must be a list of guidance strings")
        result[role] = [_text(item, f"craft_input.{role}[{index}]") for index, item in enumerate(items)]
    return result


def _scene_design(value: Any) -> dict[str, str]:
    """Validate optional branch-local directing metadata, never source canon."""
    if not isinstance(value, dict):
        raise RoleplayError("scene_design must be an object")
    unknown = set(value) - SCENE_DESIGN_KEYS
    if unknown:
        raise RoleplayError(f"Unknown scene_design keys: {', '.join(sorted(map(str, unknown)))}")
    result = {}
    for key, item in value.items():
        if not isinstance(item, str) or not item.strip():
            raise RoleplayError(f"scene_design.{key} must be a non-empty string")
        result[key] = item.strip()
    return result


def _recheck(vault: Path, state: dict[str, Any]) -> None:
    if Path(state.get("vault_root", "")).resolve() != vault.resolve():
        raise RoleplayError("Roleplay session is bound to a different active vault")
    for source in state["readiness"]["sources"]:
        rel = Path(source["path"])
        unresolved = vault / rel
        if rel.is_absolute() or ".." in rel.parts:
            raise RoleplayError(f"Roleplay source is no longer available: {source['source_id']}")
        if any(p.is_symlink() or (hasattr(p, "is_junction") and p.is_junction()) for p in (unresolved, *unresolved.parents) if p != vault.parent):
            raise RoleplayError(f"Roleplay source cannot use a symlink or junction: {source['source_id']}")
        path = unresolved.resolve()
        if not path.is_relative_to(vault) or not path.is_file():
            raise RoleplayError(f"Roleplay source is no longer available: {source['source_id']}")
        if _hash(path.read_bytes()) != source["sha256"]:
            raise RoleplayError(f"Roleplay source drift detected: {source['source_id']}")


def _check_revision(state: dict[str, Any], expected_revision: Any) -> None:
    if type(expected_revision) is not int or expected_revision != state["revision"]:
        raise RoleplayError("Stale roleplay revision; reload status before continuing")


def _summary(state: dict[str, Any]) -> dict[str, Any]:
    return {"session_id": state["session_id"], "branch_id": state["branch_id"], "hero_id": state["hero_id"],
            "series_id": state["series_id"], "story_time": state["story_time"], "revision": state["revision"],
            "run_state": state["run_state"], "phase": state["phase"], "turn_number": len(state["turns"]),
            "current_hero_state_status": state.get("current_hero_state_status", "unknown"),
            "skeleton_accepted_content_revision": state.get("skeleton_accepted_content_revision"),
            "scene_context_complete": bool(state.get("scene_context")) and all(
                state["scene_context"].get(field) for field in SCENE_CONTEXT_REQUIRED),
            "formatting_ready": state.get("skeleton_accepted_content_revision") == state["content_revision"] and bool(state["turns"])}


def _has_open_issues(state: dict[str, Any]) -> bool:
    return any(not isinstance(issue, dict) or issue.get("status", "open") != "resolved"
               for issue in state.get("issues", []))


def _continued_memory(project: Path, vault: Path, previous_session: Any, spec: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, list[Any]], list[dict[str, Any]], dict[str, Any] | None]:
    if previous_session is None:
        return [], [], {}, [], None
    _, _, previous_path = _paths(project, vault, previous_session)
    prior = _load(previous_path)
    _recheck(vault, prior)
    if prior["run_state"] != "finished" or prior.get("skeleton_accepted_content_revision") != prior["content_revision"]:
        raise RoleplayError("Continuation requires a finished branch with its current skeleton accepted")
    if prior["hero_id"] != spec["hero_id"] or prior["series_id"] != spec["series_id"]:
        raise RoleplayError("Continuation must keep the same hero and series binding")
    before = prior["story_time"].get("ordinal")
    after = spec["story_time"].get("ordinal")
    if type(before) is not int or type(after) is not int or after <= before:
        raise RoleplayError("Continuation requires a later integer story_time.ordinal")
    # Only accepted branch experience carries forward. Probe hypotheses and
    # unaccepted character changes are deliberately not inherited.
    memory = [dict(item) for item in prior["hero_memory"]]
    leader_memory = _historicalize_npc_memory(prior["leader_memory"], prior)
    deltas = {field: list(items) for field, items in prior.get("accepted_character_deltas", {}).items()}
    past = [dict(item) for item in prior.get("past_hero_experience", [])]
    accepted_content_revision = prior["skeleton_accepted_content_revision"]
    for event in _hero_visible_history(prior):
        past.append({"source_session_id": prior["session_id"], "source_branch_id": prior["branch_id"],
                     "source_story_time": prior["story_time"], "turn": event["turn"],
                     "accepted_content_revision": accepted_content_revision,
                     **{key: value for key, value in event.items() if key != "turn"}})
    deduplicated = []
    seen = set()
    for item in past:
        identity = (item["source_session_id"], item["turn"])
        if identity not in seen:
            seen.add(identity)
            deduplicated.append(item)
    return memory, leader_memory, deltas, deduplicated, {"session_id": previous_session, "story_time_id": prior["story_time"]["id"],
                                                         "accepted_revision": prior["revision"]}


def _historicalize_npc_memory(memory: list[dict[str, Any]], prior: dict[str, Any]) -> list[dict[str, Any]]:
    result=[]
    for item in memory:
        copied=dict(item); holder=copied.get("holder")
        if isinstance(holder,str) and holder.startswith("npc:"):
            copied["historical_origin"]=copied.get("historical_origin") or {
                "session_id":prior["session_id"],"branch_id":prior["branch_id"],
                "story_time":copy.deepcopy(prior["story_time"]),"holder":holder,
                "basis_event":copied.get("basis_event")}
            copied["holder"]="historical:"+holder
        result.append(copied)
    return result


def _hero_visible_history(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Allowlist the only turn history that may enter a hero context."""
    result = []
    for turn in state["turns"]:
        event = {"turn": turn["turn"], "text": turn["situation"]["text"],
                 "revealed_observations": list(turn["situation"].get("revealed_to_hero", []))}
        safe_event = _semantics().project_event_for_hero(turn.get("event"))
        if safe_event:
            event["stimulus_event"] = safe_event
        if "hero_action" in turn:
            event["hero_action_attempted"] = turn["hero_action"]
        result.append(event)
    return result


def dispatch(project_root: Path, vault_root: Path, action: str, args: dict[str, Any]) -> dict[str, Any]:
    if action == "kernel_check":
        runtime = args.get("runtime")
        inventory = args.get("inventory")
        if not isinstance(runtime, dict) or not isinstance(inventory, dict):
            raise RoleplayError("kernel_check runtime and inventory must be objects")
        scene_context = runtime.get("scene_context", {})
        if not isinstance(scene_context, dict):
            raise RoleplayError("kernel_check runtime.scene_context must be an object")
        kernel = _semantics().validate_kernel(runtime.get("kernel"), inventory, scene_context)
        return {"structural_only": True, "kernel": {role: _semantics().project_kernel(kernel, role, inventory=inventory, scene_context=scene_context)
                for role in ("leader", "hero", "formatter")},
                "semantic_limit": "Shape, declared references, and role visibility are checked mechanically; source provenance, claim support, causal tact, and reaction fit are not verified and require host review."}
    if action in {"context_prepare", "context_project"}:
        import importlib.util
        path = Path(__file__).with_name("roleplay_context.py")
        module_spec = importlib.util.spec_from_file_location("talewisp_roleplay_context", path)
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        try:
            if action == "context_prepare":
                return module.prepare_context(vault_root, args.get("request"))
            return {"role_packets": module.build_role_packets(args.get("inventory") or {})}
        except (module.ContextError, KeyError, TypeError) as exc:
            raise RoleplayError(str(exc)) from exc
    if action == "readiness":
        return readiness(project_root, vault_root, args.get("spec"))
    if action == "probes":
        return {"optional": True, "auto_run": False, "probes": PROBE_BRIEFS}
    project, vault, target = _paths(project_root, vault_root, args.get("session_id"))
    if action == "start":
        spec = args.get("spec")
        ready = readiness(project, vault, spec)
        if not ready["offerable"]:
            if not ready.get("scene_context_complete", True):
                raise RoleplayError("Roleplay start requires complete scene_context; see readiness.scene_context_issues")
            raise RoleplayError("Roleplay start requires a current complete context inventory and independent audit; analysis remains available without starting a branch")
        if target.exists():
            raise RoleplayError("Roleplay branch already exists; starting a new branch requires another session_id")
        safe = (_safe_spec_v2(vault, spec["request"], spec["inventory"], ready)
                if spec.get("context_version") == 2 else _safe_spec(vault, spec))
        inherited_memory, inherited_leader_memory, accepted_deltas, past_experience, continuation = _continued_memory(
            project, vault, args.get("continue_from_session_id"), safe)
        for field, values in accepted_deltas.items():
            safe["hero"][field] = values
        initial_hero_memory = inherited_memory + [{"kind": item.get("kind", "fact"), "text": item["value"],
                                                   "certainty": item.get("certainty", "observed"), "provenance": "character_source"}
                                                  for item in safe["hero"]["knowledge"]]
        initial_character = {field: copy.deepcopy(safe["hero"][field]) for field in ("traits", "motives", "goals")}
        initial_hero_state = {"position": safe["scene_context"]["hero_position"]["value"],
                              "activity": safe["scene_context"]["hero_activity"]["value"]}
        state = {"schema_version": 1, "session_id": args["session_id"], "vault_root": str(vault), "branch_id": safe["branch_id"],
                 "hero_id": safe["hero_id"], "series_id": safe["series_id"], "story_time": safe["story_time"],
                 "readiness": {"sources": safe["sources"], "semantic_review": safe["semantic_review"]},
                 "world": safe["world"], "hero": safe["hero"], "scene": safe["scene"],
                 "scene_design": safe["scene_design"], "scene_context": safe["scene_context"],
                 "source_excerpts": safe["source_excerpts"], "craft_input": safe["craft_input"], "revision": 1,
                 "role_context_packets": safe.get("role_context_packets"), "context_hashes": safe.get("context_hashes"),
                  "fact_target_index": safe.get("fact_target_index"),
                 "kernel": safe.get("kernel", []),
                 "unknowns": safe.get("unknowns", []), "hero_kernel_fact_ids": safe.get("hero_kernel_fact_ids", []),
                 "run_state": "active", "phase": "situation", "turns": [], "content_revision": 0,
                 "hero_memory": initial_hero_memory, "initial_hero_memory": [dict(item) for item in initial_hero_memory],
                 "initial_character": initial_character,
                 "leader_memory": inherited_leader_memory, "initial_leader_memory": [dict(item) for item in inherited_leader_memory],
                 "past_hero_experience": past_experience,
                 "continued_from": continuation, "accepted_character_deltas": accepted_deltas,
                 "current_hero_state": initial_hero_state, "current_hero_state_status": "resolved",
                 "hero_state_history": [{"revision": 1, "turn": 0, "phase": "start", "event": "initial_state",
                                         "status": "resolved", "state": copy.deepcopy(initial_hero_state)}],
                 "probe_hypotheses": {}, "skeleton_accepted_content_revision": None,
                 "created_at": datetime.now(timezone.utc).isoformat()}
        _save(target, state)
        return _summary(state)

    state = _load(target)
    _recheck(vault, state)  # Every resumed/read turn detects source drift.
    if action == "status":
        return {**_summary(state), "issues": copy.deepcopy(state.get("issues", []))}  # Leader-only MCP surface; never expose to a hero dispatch.
    if action == "packet":
        role = args.get("role")
        if role == "leader":
            state_projection = _hero_state_projection(state)
            return {"role": "leader", "branch_id": state["branch_id"], "story_time": state["story_time"],
                    "world": state["world"], "scene_contract": state["scene"], "hero_declarations": state["hero"],
                    "scene_design": state.get("scene_design", {}), "scene_context": state.get("scene_context", {}),
                    "semantic_kernel": _project_branch_kernel(state, "leader"),
                    "unknowns": copy.deepcopy(state.get("unknowns", [])),
                    "source_excerpts": state.get("source_excerpts", []),
                    "role_context": (state.get("role_context_packets") or {}).get("leader", []),
                    "craft_input": state.get("craft_input", {}).get("leader", []),
                    "craft_input_label": "Author-provided craft guidance/examples only; not world facts or hero knowledge.",
                    "contract": LEADER_CONTRACT,
                    "host_review_checklist": HOST_REVIEW_CHECKLIST,
                    "issues": copy.deepcopy(state.get("issues", [])),
                    **state_projection,
                    "hero_state_history": state.get("hero_state_history", []),
                    "leader_memory": state["leader_memory"], "past_hero_experience": state["past_hero_experience"],
                    "turns": state["turns"], "phase": state["phase"], "revision": state["revision"],
                    "run_state": state["run_state"]}
        if role == "hero":
            turn = state["turns"][-1] if state["turns"] else None
            revealed = turn.get("situation", {}).get("revealed_to_hero", []) if turn else []
            situation_history = _hero_visible_history(state)
            context = state.get("scene_context", {})
            hero_context = {key: context[key]["value"] for key in ("hero_position", "hero_activity") if key in context}
            hero_context["hero_initial_context"] = [item["value"] for item in context.get("hero_initial_context", [])]
            state_projection = _hero_state_projection(state)
            changed_fields = set(state.get("accepted_character_deltas", {}))
            if changed_fields and state.get("context_hashes") and not isinstance(state.get("fact_target_index"), dict):
                raise RoleplayError("This audited roleplay branch lacks its fact target index; refusing to guess accepted character overrides")
            changed_targets = {f"hero.{field}" for field in changed_fields}
            role_context = [item for item in (state.get("role_context_packets") or {}).get("hero", [])
                            if state.get("fact_target_index", {}).get(item.get("fact_id")) not in changed_targets]
            return {"role": "hero", "hero_id": state["hero_id"], "scene_time": state["story_time"],
                    "starting_context": hero_context,
                    "semantic_kernel": _project_branch_kernel(state, "hero"),
                    **state_projection,
                    "hero_state_history": _project_hero_state_history(state.get("hero_state_history", [])),
                    "character": {field: [{"value": item["value"]} for item in state["hero"][field]]
                                  for field in ("traits", "motives", "goals")},
                    "role_context": role_context,
                    "role_context_scope": "Source-backed entry context. Current accepted character fields above override source traits, motives, and goals for fields changed in this branch.",
                    "personal_memory": state["hero_memory"], "revealed_observations": revealed,
                    "situation_history": situation_history,
                    "past_hero_experience": state["past_hero_experience"],
                    "contract": HERO_CONTRACT,
                    "craft_input": state.get("craft_input", {}).get("hero", []),
                    "craft_input_label": "Author-provided craft guidance/examples only; not world facts, memories, or hero knowledge.",
                    "starting_context_rule": "starting_context describes entry conditions and what was already perceived then. It is not forever-current: use later situation_history observations to update present conditions. Question or investigate claims that conflict with the hero's knowledge or perception.",
                    "current_situation": ({**turn["situation"], **({"event_observations": _semantics().project_event_for_hero(turn["event"])} if _semantics().project_event_for_hero(turn.get("event")) else {})} if turn else None),
                    "perception_rule": "Read situation_history in turn order. When a later observation conflicts with an earlier one, treat the later one as current and the earlier one as past. Leader consequences and leader memory are not hero knowledge.",
                    "past_experience_rule": "past_hero_experience comes from accepted earlier scenes. It is historical context, never a current observation or proof of present conditions. Current-scene observations in situation_history govern the current scene.",
                    "action_expected": state["run_state"] == "active" and state["phase"] == "hero_action"}
        if role == "formatter":
            if state.get("skeleton_accepted_content_revision") != state["content_revision"] or not state["turns"]:
                raise RoleplayError("Formatting requires an explicitly accepted current skeleton revision")
            voice = args.get("voice_input")
            if not isinstance(voice, dict) or not voice:
                raise RoleplayError("Formatting packet requires selected author voice input")
            return {"role": "formatter", "accepted_skeleton": _skeleton(state), "voice_input": voice,
                    "semantic_kernel": _semantics().project_kernel(state.get("kernel", []), "formatter"),
                    "role_context": (state.get("role_context_packets") or {}).get("formatter", []),
                    "craft_input": state.get("craft_input", {}).get("formatter", []),
                    "craft_input_label": "Author-provided craft guidance/examples only; not story facts.",
                    "contract": FORMATTER_CONTRACT}
        raise RoleplayError("role must be leader, hero, or formatter")
    if state["run_state"] == "finished":
        raise RoleplayError("Finished roleplay branches are immutable")
    if state["run_state"] in {"paused", "stopped"} and action not in {"resume", "stop"}:
        raise RoleplayError("Roleplay branch is paused or stopped; explicit resume is required")
    if action == "pause":
        _check_revision(state, args.get("expected_revision"))
        if state["run_state"] != "active":
            raise RoleplayError("Only an active roleplay branch can be paused")
        state["run_state"] = "paused"
    elif action == "resume":
        _check_revision(state, args.get("expected_revision"))
        if state["run_state"] not in {"paused", "stopped"}:
            raise RoleplayError("Only a paused or stopped branch can be resumed")
        state["run_state"] = "active"  # Resume changes status only; it dispatches no role.
    elif action == "stop":
        _check_revision(state, args.get("expected_revision"))
        if state["run_state"] not in {"active", "paused"}:
            raise RoleplayError("Only an active or paused branch can be stopped")
        state["run_state"] = "stopped"
    elif action == "issue":
        _check_revision(state, args.get("expected_revision"))
        if state["run_state"] != "active": raise RoleplayError("Issue can only pause an active branch")
        category = _text(args.get("category"), "issue category", minimum=1)
        state.setdefault("issues", []).append({"turn": len(state["turns"]), "text": _text(args.get("text"), "issue"), "category": category, "status": "open"})
        state["run_state"] = "paused"
        state["skeleton_accepted_content_revision"] = None
    elif action == "set_hero_state":
        _check_revision(state, args.get("expected_revision"))
        if state["run_state"] != "active":
            raise RoleplayError("Current hero state can only be recorded on an active branch")
        updates = _validated_hero_state_updates(args.get("hero_state_updates"), required=True)
        _apply_hero_state_updates(state, updates, event="set_hero_state", revision=state["revision"] + 1)
    elif action == "finish":
        _check_revision(state, args.get("expected_revision"))
        if _has_open_issues(state):
            raise RoleplayError("Finish is blocked while an issue is open")
        if state["run_state"] != "active" or state.get("skeleton_accepted_content_revision") != state["content_revision"]:
            raise RoleplayError("Finish requires an active branch and an accepted current skeleton")
        state["run_state"] = "finished"
    elif action == "situation":
        _require_active(state, "situation")
        _check_revision(state, args.get("expected_revision"))
        situation = {"text": _text(args.get("text"), "situation"),
                     "revealed_to_hero": args.get("revealed_to_hero", [])}
        if not isinstance(situation["revealed_to_hero"], list) or any(not isinstance(x, str) or not x.strip() for x in situation["revealed_to_hero"]):
            raise RoleplayError("revealed_to_hero must be a list of observations")
        state_updates = _validated_hero_state_updates(args.get("hero_state_updates"))
        raw_event = args.get("event")
        if raw_event is not None:
            raw_event = copy.deepcopy(raw_event)
            raw_event["revealed_to_hero"] = list(situation["revealed_to_hero"])
        event = _semantics().validate_event(raw_event, state["turns"], state.get("kernel", [])) if raw_event is not None else None
        if state_updates:
            _apply_hero_state_updates(state, state_updates, event="situation", revision=state["revision"] + 1)
        record = {"turn": len(state["turns"]) + 1, "situation": situation}
        if event is not None:
            event = copy.deepcopy(event)
            event["revealed_to_hero"] = list(situation["revealed_to_hero"])
            record["event"] = event
        state["turns"].append(record)
        state["phase"] = "hero_action"
    elif action == "hero_action":
        _require_active(state, "hero_action")
        _check_revision(state, args.get("expected_revision"))
        turn = state["turns"][-1]
        stimulus = args.get("stimulus_ref")
        if state.get("kernel") or stimulus is not None:
            stimulus = _semantics().validate_stimulus(stimulus, state["turns"][:-1], turn.get("event"))
        turn["hero_action"] = _text(args.get("text"), "hero action")
        if stimulus is not None: turn["stimulus_ref"] = stimulus
        meaning = args.get("meaning_ref")
        if meaning is not None:
            visible = {x["id"] for x in _project_branch_kernel(state, "hero")}
            if meaning not in visible: raise RoleplayError("meaning_ref must identify a hero-visible kernel item")
            turn["meaning_ref"] = meaning
        state_snapshot = copy.deepcopy(
            state.get("current_hero_state") if state.get("current_hero_state_status") == "resolved" else None)
        state["turns"][-1]["hero_state_snapshot"] = state_snapshot
        state["turns"][-1]["character_state"] = {
            field: copy.deepcopy(state["hero"][field]) for field in ("traits", "motives", "goals")}
        state["current_hero_state_status"] = "unresolved"
        state["hero_state_history"].append({"revision": state["revision"] + 1,
            "turn": state["turns"][-1]["turn"], "phase": "hero_action", "event": "hero_action_attempted",
            "status": "unresolved", "last_resolved_state": state_snapshot})
        state["phase"] = "consequence"
    elif action == "consequence":
        _require_active(state, "consequence")
        _check_revision(state, args.get("expected_revision"))
        text = _text(args.get("text"), "consequence")
        state["turns"][-1]["consequence"] = text
        state_updates = _validated_hero_state_updates(args.get("hero_state_updates"))
        if state_updates:
            _apply_hero_state_updates(state, state_updates, event="consequence", revision=state["revision"] + 1)
        updates = args.get("memory_updates", [])
        leader_updates = args.get("leader_memory_updates", [])
        state["turns"][-1]["hero_memory_updates"] = _validated_memory_updates(
            updates, f"turn:{state['turns'][-1]['turn']}")
        state["turns"][-1]["leader_memory_updates"] = _validated_memory_updates(
            leader_updates, f"turn:{state['turns'][-1]['turn']}", include_holder=True)
        for update in leader_updates:
            _semantics().validate_npc_memory(update, state["turns"][:-1], state["turns"][-1].get("event"))
        state["hero_memory"].extend(state["turns"][-1]["hero_memory_updates"])
        state["leader_memory"].extend(state["turns"][-1]["leader_memory_updates"])
        state["phase"] = "situation"
    elif action == "probe_answer":
        _check_revision(state, args.get("expected_revision"))
        probe_id = args.get("probe_id")
        if probe_id not in {p["probe_id"] for p in PROBE_BRIEFS}:
            raise RoleplayError("Unknown probe_id")
        state["probe_hypotheses"][probe_id] = {"answer": _text(args.get("answer"), "probe answer"),
                                                "status": "hypothesis", "revision": state["revision"] + 1}
    elif action == "accept_probe_delta":
        _check_revision(state, args.get("expected_revision"))
        probe_id = args.get("probe_id")
        if probe_id not in state["probe_hypotheses"]:
            raise RoleplayError("Probe must have an answer before an author delta can be accepted")
        delta = args.get("author_delta")
        if not isinstance(delta, dict) or not delta:
            raise RoleplayError("author_delta must name exact hero fields to change")
        allowed = {"traits", "motives", "goals"}
        if set(delta) - allowed:
            raise RoleplayError("Only explicitly named traits, motives, or goals may be corrected")
        for field, value in delta.items():
            if not isinstance(value, list) or not value:
                raise RoleplayError(f"Author delta for {field} must be a non-empty full field value list")
            normalized = []
            for item in value:
                if isinstance(item, str):
                    normalized.append({"value": _text(item, f"author delta {field}")})
                elif isinstance(item, dict):
                    normalized.append({"value": _text(item.get("value"), f"author delta {field}")})
                else:
                    raise RoleplayError(f"Author delta for {field} must contain text declarations")
            state["hero"][field] = normalized
            state["accepted_character_deltas"][field] = normalized
        state["probe_hypotheses"][probe_id]["status"] = "author_corrected"
        state["probe_hypotheses"][probe_id]["accepted_fields"] = sorted(delta)
    elif action == "accept_skeleton":
        _check_revision(state, args.get("expected_revision"))
        if _has_open_issues(state):
            raise RoleplayError("Skeleton acceptance is blocked while an issue is open")
        if state["run_state"] != "active" or not state["turns"] or state["phase"] != "situation":
            raise RoleplayError("A complete current skeleton is required before acceptance")
        if not all("hero_action" in t and "consequence" in t for t in state["turns"]):
            raise RoleplayError("Every turn must have a hero action and consequence")
        if args.get("accepted") is not True:
            raise RoleplayError("Explicit author acceptance is required")
        state["skeleton_accepted_content_revision"] = state["content_revision"]
    else:
        raise RoleplayError(f"Unknown roleplay action: {action}")
    if action in {"situation", "hero_action", "consequence", "accept_probe_delta", "set_hero_state", "issue"}:
        state["content_revision"] += 1
    state["revision"] += 1
    _save(target, state)
    return _summary(state)


def _require_active(state: dict[str, Any], phase: str) -> None:
    if state["run_state"] != "active":
        raise RoleplayError("Roleplay branch is paused; explicit resume is required")
    if state["phase"] != phase:
        raise RoleplayError(f"Expected phase {phase}, current phase is {state['phase']}")


def _validated_hero_state_updates(value: Any, *, required: bool = False) -> dict[str, str]:
    if value is None and not required:
        return {}
    if not isinstance(value, dict) or set(value) != {"position", "activity"}:
        raise RoleplayError("hero_state_updates must contain exactly non-empty position and activity strings")
    return {key: _text(value[key], f"hero_state_updates.{key}") for key in ("position", "activity")}


def _apply_hero_state_updates(state: dict[str, Any], updates: dict[str, str], *, event: str, revision: int) -> None:
    state["current_hero_state"] = dict(updates)
    state["current_hero_state_status"] = "resolved"
    turn = len(state["turns"]) + (1 if event == "situation" else 0)
    state.setdefault("hero_state_history", []).append({
        "revision": revision, "turn": turn, "phase": state["phase"], "event": event,
        "status": "resolved", "state": dict(updates),
    })


def _hero_state_projection(state: dict[str, Any]) -> dict[str, Any]:
    status = state.get("current_hero_state_status", "unknown")
    if status == "resolved" and isinstance(state.get("current_hero_state"), dict):
        return {"current_hero_state": copy.deepcopy(state["current_hero_state"]),
                "current_hero_state_scope": "Explicitly resolved current position and activity."}
    if status == "unresolved":
        scope = "Current position/activity is unresolved after the latest hero action; prior snapshots are historical only."
    else:
        scope = "Current position/activity is unknown; do not infer it from entry context or prose history."
    return {"current_hero_state": None, "current_hero_state_scope": scope}


def _project_hero_state_history(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Expose timed physical state only, without branch revision/control metadata."""
    projected = []
    for item in history:
        entry = {"turn": item.get("turn", 0), "phase": item.get("phase", "unknown"),
                 "scope": item.get("status", "unknown")}
        if isinstance(item.get("state"), dict):
            entry.update(item["state"])
        if isinstance(item.get("last_resolved_state"), dict):
            entry["last_resolved_state"] = copy.deepcopy(item["last_resolved_state"])
        projected.append(entry)
    return projected


def _validated_memory_updates(updates: Any, provenance: str, *, include_holder: bool = False) -> list[dict[str, str]]:
    if not isinstance(updates, list):
        raise RoleplayError("Memory updates must be a list")
    result = []
    for update in updates:
        if not isinstance(update, dict) or update.get("kind") not in {"fact", "belief"}:
            raise RoleplayError("Each memory update must be a fact or belief")
        fact = _text(update.get("text"), "memory update")
        certainty = update.get("certainty", "observed")
        if certainty not in {"observed", "inferred", "uncertain"}:
            raise RoleplayError("Memory certainty must be observed, inferred, or uncertain")
        if not include_holder and ("holder" in update or "basis_event" in update):
            raise RoleplayError("Hero memory updates cannot assign holders or NPC basis events")
        result.append({"kind": update["kind"], "text": fact, "certainty": certainty, "provenance": provenance})
        if include_holder: result[-1]["holder"] = update.get("holder", "world")
        if update.get("holder") is not None: result[-1]["holder"] = update["holder"]
        if update.get("basis_event") is not None: result[-1]["basis_event"] = update["basis_event"]
    return result


def _skeleton(state: dict[str, Any]) -> dict[str, Any]:
    def values(group: dict[str, Any]) -> dict[str, Any]:
        return {key: ([{k: item[k] for k in ("value", "kind", "certainty") if k in item} for item in value]
                      if isinstance(value, list) else value) for key, value in group.items()}
    clean_turns = []
    for turn in state["turns"]:
        clean_turn = {"turn": turn["turn"], "situation": turn["situation"],
                            "hero_action": turn["hero_action"], "consequence": turn["consequence"],
                            "character_state": values(turn["character_state"]),
                            "hero_memory_updates": turn.get("hero_memory_updates", [])}
        if "hero_state_snapshot" in turn:
            clean_turn["hero_state_snapshot"] = copy.deepcopy(turn["hero_state_snapshot"])
        safe_event = _semantics().project_event_for_hero(turn.get("event"))
        if safe_event:
            clean_turn["event"] = safe_event
        for key in ("stimulus_ref", "meaning_ref"):
            if key in turn: clean_turn[key] = turn[key]
        clean_turns.append(clean_turn)
    initial_context = state.get("scene_context", {})
    formatter_context = {
        "hero_position": initial_context.get("hero_position", {}).get("value"),
        "hero_activity": initial_context.get("hero_activity", {}).get("value"),
        "hero_initial_context": [item.get("value", "") for item in initial_context.get("hero_initial_context", [])],
        "time_scope": "Entry conditions only; later turn observations update the current scene.",
    }
    return {"branch_id": state["branch_id"], "hero_id": state["hero_id"], "series_id": state["series_id"],
            "story_time": state["story_time"], "scene": values(state["scene"]),
            "scene_context": formatter_context,
            "current_hero_state": _hero_state_projection(state),
            "hero_state_history": _project_hero_state_history(state.get("hero_state_history", [])),
            "scene_design": copy.deepcopy(state.get("scene_design", {})),
            "initial_character": values(state.get("initial_character", {
                field: state["hero"][field] for field in ("traits", "motives", "goals")})),
            "initial_hero_memory": state["initial_hero_memory"],
            "past_hero_experience": state["past_hero_experience"], "turns": clean_turns,
            "accepted_content_revision": state["skeleton_accepted_content_revision"]}
