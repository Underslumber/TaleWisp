from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import re


def content_fingerprint(text: str) -> str:
    if type(text) is not str:
        raise TypeError("artifact content must be an exact str")
    return sha256(text.encode("utf-8")).hexdigest()


SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
UNRESOLVED_CHOICE_RE = re.compile(
    r"(?:^|\W)(?:или|либо|or|either)(?:$|\W)",
    re.IGNORECASE,
)
COMPACT_RECORD_MAX_CHARS = 8000
COMPACT_RECORD_MAX_WORDS = 900
COMPACT_RECORD_MAX_FIELD_CHARS = 320
COMPACT_CAPACITY_ERROR_PREFIXES = (
    "compact generation record exceeds the 8000-character hard limit",
    "compact generation record exceeds the 900-word hard limit",
    "compact generation record contains a field longer than 320 characters",
    "compact generation record may contain at most ",
)
REQUIRED_RECORD_FIELDS = (
    "record_profile",
    "initial_state",
    "entry_ledger",
    "preservation_ledger",
    "causal_waves",
    "transition_ledger",
    "physical_effect_ledger",
    "boundary_crossing_ledger",
    "object_ledger",
    "reference_ledger",
    "assertion_ledger",
    "verification_ledger",
    "dialogue_ledger",
    "emotional_trajectory",
)
ARTIFACT_PREFIXES = {
    "input": "INPUT",
    "record": "RECORD",
    "prose": "PROSE",
}


def canonical_artifact_id(label: str, content: str) -> str:
    return f"{ARTIFACT_PREFIXES[label]}-{content_fingerprint(content)[:16]}"


def promote_compact_record_if_needed(content: str) -> tuple[str, bool]:
    """Promote a capacity-only compact record to full without a rewrite cycle."""
    if type(content) is not str:
        raise TypeError("generation record content must be an exact str")
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return content, False
    if not isinstance(data, dict) or data.get("record_profile") != "compact":
        return content, False

    sha = content_fingerprint(content)
    artifact = Artifact(canonical_artifact_id("record", content), content, sha)
    errors: list[str] = []
    _verify_record_schema(artifact, errors)
    capacity_errors = [
        error
        for error in errors
        if error.startswith(COMPACT_CAPACITY_ERROR_PREFIXES)
    ]
    blocking_errors = [error for error in errors if error not in capacity_errors]
    if not capacity_errors or blocking_errors:
        return content, False

    data["record_profile"] = "full"
    promoted = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    promoted_sha = content_fingerprint(promoted)
    promoted_artifact = Artifact(
        canonical_artifact_id("record", promoted),
        promoted,
        promoted_sha,
    )
    promoted_errors: list[str] = []
    _verify_record_schema(promoted_artifact, promoted_errors)
    if promoted_errors:
        return content, False
    return promoted, True


def _is_nonempty_string(value: object) -> bool:
    return type(value) is str and bool(value.strip())


def _record_word_count(text: str) -> int:
    return len(re.findall(r"[\w-]+", text, re.UNICODE))


def _walk_strings(value: object):
    if type(value) is str:
        yield value
    elif isinstance(value, dict):
        for nested in value.values():
            yield from _walk_strings(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _walk_strings(nested)


def _contains_unresolved_choice(value: object) -> bool:
    return type(value) is str and bool(UNRESOLVED_CHOICE_RE.search(value))


def _reject_unknown_keys(
    label: str,
    value: dict,
    allowed: tuple[str, ...] | set[str],
    errors: list[str],
) -> None:
    unknown = set(value) - set(allowed)
    for key in sorted(unknown):
        errors.append(f"{label} contains unknown field: {key}")


@dataclass(frozen=True)
class Artifact:
    artifact_id: str
    content: str
    declared_sha256: str

    @property
    def computed_sha256(self) -> str:
        return content_fingerprint(self.content)


@dataclass(frozen=True)
class ArtifactSet:
    input_set: Artifact
    generation_record: Artifact
    prose: Artifact


@dataclass(frozen=True)
class ReviewPass:
    verdict: str
    mode: str
    reviewer_task: str
    writer_task: str
    input_id: str = ""
    input_sha256: str = ""
    record_id: str = ""
    record_sha256: str = ""
    prose_id: str = ""
    prose_sha256: str = ""
    fork_turns: str = ""
    payload_scope: str = ""


@dataclass(frozen=True)
class PassSet:
    generation_record: ReviewPass
    context: ReviewPass
    cold: ReviewPass


def _verify_artifact(label: str, artifact: Artifact, errors: list[str]) -> None:
    if type(artifact.content) is not str:
        errors.append(f"{label} content is not an exact str")
        return
    if type(artifact.artifact_id) is not str:
        errors.append(f"{label} ID is not an exact str")
        return
    if type(artifact.declared_sha256) is not str:
        errors.append(f"{label} declared SHA-256 is not an exact str")
        return
    if not artifact.artifact_id.strip():
        errors.append(f"{label} ID is empty")
    if not SHA256_RE.fullmatch(artifact.declared_sha256):
        errors.append(f"{label} declared SHA-256 is malformed")
    if artifact.declared_sha256 != artifact.computed_sha256:
        errors.append(f"{label} SHA-256 does not match literal content")
    expected_id = canonical_artifact_id(label, artifact.content)
    if artifact.artifact_id != expected_id:
        errors.append(f"{label} ID does not match literal content")


def _verify_record_schema(record: Artifact, errors: list[str]) -> None:
    try:
        data = json.loads(record.content)
    except json.JSONDecodeError:
        errors.append("generation record is not valid JSON")
        return
    if not isinstance(data, dict):
        errors.append("generation record must be a JSON object")
        return
    _reject_unknown_keys(
        "generation record",
        data,
        set(REQUIRED_RECORD_FIELDS),
        errors,
    )
    for field in REQUIRED_RECORD_FIELDS:
        if field not in data:
            errors.append(f"generation record field is missing: {field}")
    if errors:
        return

    profile = data["record_profile"]
    initial = data["initial_state"]
    entry = data["entry_ledger"]
    preservation = data["preservation_ledger"]
    waves = data["causal_waves"]
    transitions = data["transition_ledger"]
    physical_effects = data["physical_effect_ledger"]
    boundary_crossings = data["boundary_crossing_ledger"]
    objects = data["object_ledger"]
    references = data["reference_ledger"]
    assertions = data["assertion_ledger"]
    verification = data["verification_ledger"]
    dialogue = data["dialogue_ledger"]
    emotion = data["emotional_trajectory"]

    if profile not in {"compact", "full"}:
        errors.append("record_profile must be compact or full")
    if profile == "compact":
        if len(record.content) > COMPACT_RECORD_MAX_CHARS:
            errors.append(
                "compact generation record exceeds the 8000-character hard limit"
            )
        if _record_word_count(record.content) > COMPACT_RECORD_MAX_WORDS:
            errors.append(
                "compact generation record exceeds the 900-word hard limit"
            )
        for value in _walk_strings(data):
            if len(value) > COMPACT_RECORD_MAX_FIELD_CHARS:
                errors.append(
                    "compact generation record contains a field longer than 320 characters"
                )
                break

    required_mapping_fields = {
        "initial_state": (
            initial,
            ("place", "staging", "character_knowledge", "reader_knowledge"),
        ),
        "entry_ledger": (
            entry,
            (
                "mode",
                "opening_beat",
                "prior_action_status",
                "prior_action_reader_source",
                "first_state_change",
                "first_state_change_source",
                "first_focus_handoff",
                "presupposition_basis",
            ),
        ),
        "preservation_ledger": (
            preservation,
            (
                "event_chain",
                "message",
                "climax",
                "author_delta",
                "protected_beats",
                "prohibited_additions",
                "minimal_scope",
            ),
        ),
        "emotional_trajectory": (
            emotion,
            ("perceived_cause", "state_change", "next_effect"),
        ),
    }
    for label, (value, fields) in required_mapping_fields.items():
        if not isinstance(value, dict):
            errors.append(f"{label} must be an object")
            continue
        _reject_unknown_keys(label, value, fields, errors)
        for field in fields:
            if field not in value:
                errors.append(f"{label}.{field} is missing")

    if isinstance(initial, dict):
        for field in ("place", "staging"):
            if field in initial and not _is_nonempty_string(initial[field]):
                errors.append(f"initial_state.{field} must be a non-empty string")
        for field in ("character_knowledge", "reader_knowledge"):
            if field in initial and not isinstance(initial[field], list):
                errors.append(f"initial_state.{field} must be a list")
            elif field in initial and any(
                not _is_nonempty_string(item) for item in initial[field]
            ):
                errors.append(
                    f"initial_state.{field} entries must be non-empty strings"
                )

    if isinstance(entry, dict):
        for field in (
            "mode",
            "opening_beat",
            "prior_action_status",
            "prior_action_reader_source",
            "first_state_change",
            "first_state_change_source",
            "first_focus_handoff",
            "presupposition_basis",
        ):
            if field in entry and not _is_nonempty_string(entry[field]):
                errors.append(f"entry_ledger.{field} must be a non-empty string")
        if entry.get("mode") not in {"standalone", "continuation"}:
            errors.append("entry_ledger.mode is not an allowed value")
        if entry.get("prior_action_status") not in {
            "no_prior_action",
            "shown_in_opening",
            "established_in_preceding_prose",
            "intentional_ellipsis",
        }:
            errors.append(
                "entry_ledger.prior_action_status is not an allowed value"
            )
        if (
            entry.get("mode") == "standalone"
            and entry.get("prior_action_status")
            == "established_in_preceding_prose"
        ):
            errors.append(
                "standalone entry cannot rely on an action established only in preceding prose"
            )
        if (
            entry.get("prior_action_status") == "no_prior_action"
            and entry.get("prior_action_reader_source") != "not_applicable"
        ):
            errors.append(
                "entry_ledger.prior_action_reader_source must be not_applicable when there is no prior action"
            )

    if isinstance(preservation, dict):
        if "event_chain" in preservation and (
            not isinstance(preservation["event_chain"], list)
            or not preservation["event_chain"]
        ):
            errors.append("preservation_ledger.event_chain must be a non-empty list")
        elif "event_chain" in preservation and any(
            not _is_nonempty_string(item)
            for item in preservation["event_chain"]
        ):
            errors.append(
                "preservation_ledger.event_chain entries must be non-empty strings"
            )
        for field in ("message", "climax", "author_delta", "minimal_scope"):
            if field in preservation and not _is_nonempty_string(preservation[field]):
                errors.append(
                    f"preservation_ledger.{field} must be a non-empty string"
                )
        for field in ("protected_beats", "prohibited_additions"):
            if field in preservation and not isinstance(preservation[field], list):
                errors.append(f"preservation_ledger.{field} must be a list")
            elif field in preservation and any(
                not _is_nonempty_string(item) for item in preservation[field]
            ):
                errors.append(
                    f"preservation_ledger.{field} entries must be non-empty strings"
                )

    if isinstance(emotion, dict):
        for field in ("perceived_cause", "state_change", "next_effect"):
            if field in emotion and not _is_nonempty_string(emotion[field]):
                errors.append(
                    f"emotional_trajectory.{field} must be a non-empty string"
                )

    if not isinstance(waves, list) or not waves:
        errors.append("causal_waves must be a non-empty list")
    else:
        if profile == "compact" and len(waves) > 6:
            errors.append("compact generation record may contain at most 6 causal waves")
        wave_fields = (
            "id",
            "trigger",
            "perception",
            "subjective_meaning",
            "reaction",
            "action",
            "action_basis",
            "material_consequence",
            "next_focus",
        )
        for index, wave in enumerate(waves):
            if not isinstance(wave, dict):
                errors.append(f"causal_waves[{index}] must be an object")
                continue
            _reject_unknown_keys(
                f"causal_waves[{index}]",
                wave,
                wave_fields,
                errors,
            )
            for field in wave_fields:
                if not _is_nonempty_string(wave.get(field)):
                    errors.append(
                        f"causal_waves[{index}].{field} must be a non-empty string"
                    )
            if profile == "compact" and _contains_unresolved_choice(
                wave.get("action")
            ):
                errors.append(
                    f"causal_waves[{index}].action contains an unresolved choice"
                )
            wave_id = wave.get("id")
            if _is_nonempty_string(wave_id):
                expected_wave_id = f"W{index + 1}"
                if wave_id != expected_wave_id:
                    errors.append(
                        f"causal_waves[{index}].id must be {expected_wave_id}"
                    )

    ledger_specs = {
        "object_ledger": (
            objects,
            (
                "id",
                "first_reader_access",
                "name",
                "aliases",
                "quantity",
                "position",
                "state_changes",
            ),
        ),
        "assertion_ledger": (
            assertions,
            ("claim", "owner", "source", "status"),
        ),
    }
    for label, (value, fields) in ledger_specs.items():
        if not isinstance(value, list) or not value:
            errors.append(f"{label} must be a non-empty list")
            continue
        if profile == "compact":
            compact_limits = {
                "object_ledger": 12,
                "assertion_ledger": 6,
            }
            if len(value) > compact_limits[label]:
                errors.append(
                    f"compact generation record {label} exceeds "
                    f"{compact_limits[label]} entries"
                )
        for index, entry in enumerate(value):
            if not isinstance(entry, dict):
                errors.append(f"{label}[{index}] must be an object")
                continue
            _reject_unknown_keys(f"{label}[{index}]", entry, fields, errors)
            for field in fields:
                if field not in entry:
                    errors.append(f"{label}[{index}].{field} is missing")
            if label == "object_ledger":
                for field in ("id", "first_reader_access", "name", "position"):
                    if field in entry and not _is_nonempty_string(entry[field]):
                        errors.append(
                            f"{label}[{index}].{field} must be a non-empty string"
                        )
                if "aliases" in entry and not isinstance(entry["aliases"], list):
                    errors.append(f"{label}[{index}].aliases must be a list")
                elif "aliases" in entry and any(
                    not _is_nonempty_string(item) for item in entry["aliases"]
                ):
                    errors.append(
                        f"{label}[{index}].aliases entries must be non-empty strings"
                    )
                if "quantity" in entry and (
                    isinstance(entry["quantity"], bool)
                    or not isinstance(entry["quantity"], (int, str))
                    or (
                        isinstance(entry["quantity"], str)
                        and not entry["quantity"].strip()
                    )
                ):
                    errors.append(
                        f"{label}[{index}].quantity must be an integer or non-empty string"
                    )
                if "state_changes" in entry and (
                    not isinstance(entry["state_changes"], list)
                    or not entry["state_changes"]
                ):
                    errors.append(
                        f"{label}[{index}].state_changes must be a non-empty list"
                    )
                elif "state_changes" in entry and any(
                    not _is_nonempty_string(item)
                    for item in entry["state_changes"]
                ):
                    errors.append(
                        f"{label}[{index}].state_changes entries must be non-empty strings"
                    )
                object_id = entry.get("id")
                if _is_nonempty_string(object_id):
                    expected_object_id = f"O{index + 1}"
                    if object_id != expected_object_id:
                        errors.append(
                            f"{label}[{index}].id must be {expected_object_id}"
                        )
                if profile == "compact" and _contains_unresolved_choice(
                    entry.get("name")
                ):
                    errors.append(
                        f"{label}[{index}].name contains an unresolved choice"
                    )
            else:
                for field in fields:
                    if field in entry and not _is_nonempty_string(entry[field]):
                        errors.append(
                            f"{label}[{index}].{field} must be a non-empty string"
                        )
                if entry.get("status") not in {
                    "fact",
                    "perception",
                    "inference",
                    "memory",
                    "lie",
                    "intentional_uncertainty",
                }:
                    errors.append(
                        f"{label}[{index}].status is not an allowed value"
                    )

    if not isinstance(references, dict):
        errors.append("reference_ledger must be an object")
    else:
        for key, value in references.items():
            if not _is_nonempty_string(key) or not _is_nonempty_string(value):
                errors.append(
                    "reference_ledger keys and antecedents must be non-empty strings"
                )
            elif re.search(r"draft|prose|чернов|проз", key, re.IGNORECASE):
                errors.append(
                    f"reference_ledger contains reserved payload-like key: {key}"
                )

    ledger_entry_fields = {
        "transition_ledger": (
            "id",
            "from_wave",
            "to_wave",
            "prior_action_state",
            "trigger_relation",
            "focus_handoff",
            "reaction_trigger",
            "reaction_order",
            "next_action_gate",
        ),
        "physical_effect_ledger": (
            "id",
            "source",
            "path_or_medium",
            "target",
            "state_change",
            "sensory_evidence",
            "sensory_source",
            "perceiver",
            "reaction",
        ),
        "boundary_crossing_ledger": (
            "id",
            "object",
            "starting_side",
            "boundary",
            "usable_clearance",
            "force_or_actor",
            "direction",
            "literal_crossing",
            "final_side",
            "reader_evidence",
        ),
        "verification_ledger": (
            "hypothesis",
            "alternative",
            "action",
            "criterion",
            "observed_result",
            "conclusion",
        ),
        "dialogue_ledger": (
            "speaker",
            "addressee",
            "requested_action",
            "intended_actor",
            "staging",
            "speaker_reason",
            "addressee_reason",
        ),
    }
    for label, value in (
        ("transition_ledger", transitions),
        ("physical_effect_ledger", physical_effects),
        ("boundary_crossing_ledger", boundary_crossings),
        ("verification_ledger", verification),
        ("dialogue_ledger", dialogue),
    ):
        if not isinstance(value, dict) or "applicable" not in value:
            errors.append(f"{label} must declare applicable")
            continue
        if type(value["applicable"]) is not bool:
            errors.append(f"{label}.applicable must be a boolean")
            continue
        allowed = {"applicable", "entries"} if value["applicable"] else {
            "applicable",
            "reason",
        }
        _reject_unknown_keys(label, value, allowed, errors)
        if value["applicable"]:
            entries = value.get("entries")
            if not isinstance(entries, list) or not entries:
                errors.append(f"{label}.entries must be a non-empty list when applicable")
                continue
            if profile == "compact":
                compact_limits = {
                    "transition_ledger": 5,
                    "physical_effect_ledger": 6,
                    "boundary_crossing_ledger": 4,
                    "verification_ledger": 3,
                    "dialogue_ledger": 6,
                }
                if len(entries) > compact_limits[label]:
                    errors.append(
                        f"compact generation record {label} exceeds "
                        f"{compact_limits[label]} entries"
                    )
            fields = ledger_entry_fields[label]
            for index, entry in enumerate(entries):
                if not isinstance(entry, dict):
                    errors.append(f"{label}.entries[{index}] must be an object")
                    continue
                _reject_unknown_keys(
                    f"{label}.entries[{index}]",
                    entry,
                    fields,
                    errors,
                )
                for field in fields:
                    if not _is_nonempty_string(entry.get(field)):
                        errors.append(
                            f"{label}.entries[{index}].{field} must be a non-empty string"
                        )
                if label == "transition_ledger":
                    transition_id = entry.get("id")
                    expected_transition_id = f"T{index + 1}"
                    if (
                        _is_nonempty_string(transition_id)
                        and transition_id != expected_transition_id
                    ):
                        errors.append(
                            f"{label}.entries[{index}].id must be {expected_transition_id}"
                        )
                    expected_from = f"W{index + 1}"
                    expected_to = f"W{index + 2}"
                    if entry.get("from_wave") != expected_from:
                        errors.append(
                            f"{label}.entries[{index}].from_wave must be {expected_from}"
                        )
                    if entry.get("to_wave") != expected_to:
                        errors.append(
                            f"{label}.entries[{index}].to_wave must be {expected_to}"
                        )
                    if entry.get("prior_action_state") not in {
                        "completed",
                        "paused",
                        "interrupted",
                        "continues",
                    }:
                        errors.append(
                            f"{label}.entries[{index}].prior_action_state is not an allowed value"
                        )
                    if entry.get("trigger_relation") not in {
                        "before",
                        "during",
                        "after",
                    }:
                        errors.append(
                            f"{label}.entries[{index}].trigger_relation is not an allowed value"
                        )
                    if entry.get("reaction_order") not in {
                        "before_consequence",
                        "during_consequence",
                        "after_consequence",
                    }:
                        errors.append(
                            f"{label}.entries[{index}].reaction_order is not an allowed value"
                        )
                elif label == "physical_effect_ledger":
                    effect_id = entry.get("id")
                    expected_effect_id = f"P{index + 1}"
                    if (
                        _is_nonempty_string(effect_id)
                        and effect_id != expected_effect_id
                    ):
                        errors.append(
                            f"{label}.entries[{index}].id must be {expected_effect_id}"
                        )
                    for field in ("source", "target"):
                        if profile == "compact" and _contains_unresolved_choice(
                            entry.get(field)
                        ):
                            errors.append(
                                f"{label}.entries[{index}].{field} contains an unresolved choice"
                            )
                elif label == "boundary_crossing_ledger":
                    crossing_id = entry.get("id")
                    expected_crossing_id = f"B{index + 1}"
                    if (
                        _is_nonempty_string(crossing_id)
                        and crossing_id != expected_crossing_id
                    ):
                        errors.append(
                            f"{label}.entries[{index}].id must be {expected_crossing_id}"
                        )
                    for field in (
                        "object",
                        "boundary",
                        "force_or_actor",
                        "direction",
                    ):
                        if profile == "compact" and _contains_unresolved_choice(
                            entry.get(field)
                        ):
                            errors.append(
                                f"{label}.entries[{index}].{field} contains an unresolved choice"
                            )
                elif label == "verification_ledger":
                    if profile == "compact" and _contains_unresolved_choice(
                        entry.get("action")
                    ):
                        errors.append(
                            f"{label}.entries[{index}].action contains an unresolved choice"
                        )
        elif not _is_nonempty_string(value.get("reason")):
            errors.append(
                f"{label}.reason must be a non-empty string when not applicable"
            )

    if isinstance(waves, list) and len(waves) > 1:
        if (
            not isinstance(transitions, dict)
            or transitions.get("applicable") is not True
        ):
            errors.append(
                "transition_ledger must be applicable when the record has multiple causal waves"
            )
        elif isinstance(transitions.get("entries"), list) and len(
            transitions["entries"]
        ) != len(waves) - 1:
            errors.append(
                "transition_ledger must contain exactly one entry per causal-wave boundary"
            )


def verify_current_passes(artifacts: ArtifactSet, passes: PassSet) -> list[str]:
    errors: list[str] = []
    for label, artifact in (
        ("input", artifacts.input_set),
        ("record", artifacts.generation_record),
        ("prose", artifacts.prose),
    ):
        _verify_artifact(label, artifact, errors)
    if type(artifacts.prose.content) is str and not artifacts.prose.content.strip():
        errors.append("prose is empty")
    _verify_record_schema(artifacts.generation_record, errors)

    record_pass = passes.generation_record
    context_pass = passes.context
    cold_pass = passes.cold
    pass_types_valid = True
    for label, review_pass in (
        ("generation-record pass", record_pass),
        ("context pass", context_pass),
        ("cold pass", cold_pass),
    ):
        for field_name in review_pass.__dataclass_fields__:
            if type(getattr(review_pass, field_name)) is not str:
                errors.append(f"{label}.{field_name} is not an exact str")
                pass_types_valid = False
    if not pass_types_valid:
        return errors

    for label, review_pass in (
        ("generation-record pass", record_pass),
        ("context pass", context_pass),
        ("cold pass", cold_pass),
    ):
        for field_name in ("reviewer_task", "writer_task"):
            value = getattr(review_pass, field_name)
            if value != value.strip():
                errors.append(
                    f"{label}.{field_name} contains leading or trailing whitespace"
                )

    writer_tasks = (
        record_pass.writer_task,
        context_pass.writer_task,
        cold_pass.writer_task,
    )
    if not all(writer_tasks) or len(set(writer_tasks)) != 1:
        errors.append("writer task identity is empty or inconsistent")

    if record_pass.verdict != "GENERATION RECORD PASS":
        errors.append("generation-record verdict is not PASS")
    if record_pass.mode != "GENERATION RECORD":
        errors.append("generation-record reviewer mode is invalid")
    if (
        not record_pass.reviewer_task
        or record_pass.reviewer_task == record_pass.writer_task
    ):
        errors.append("generation-record review is not from an independent task")
    if (
        record_pass.input_id,
        record_pass.input_sha256,
        record_pass.record_id,
        record_pass.record_sha256,
    ) != (
        artifacts.input_set.artifact_id,
        artifacts.input_set.computed_sha256,
        artifacts.generation_record.artifact_id,
        artifacts.generation_record.computed_sha256,
    ):
        errors.append("GENERATION RECORD PASS does not match current input and record")

    if context_pass.verdict != "CONTEXT PASS":
        errors.append("context verdict is not PASS")
    if context_pass.mode != "CONTEXT PROSE":
        errors.append("context reviewer mode is invalid")
    if (
        not context_pass.reviewer_task
        or context_pass.reviewer_task == context_pass.writer_task
    ):
        errors.append("context review is not from an independent task")
    if (
        context_pass.input_id,
        context_pass.input_sha256,
        context_pass.record_id,
        context_pass.record_sha256,
        context_pass.prose_id,
        context_pass.prose_sha256,
    ) != (
        artifacts.input_set.artifact_id,
        artifacts.input_set.computed_sha256,
        artifacts.generation_record.artifact_id,
        artifacts.generation_record.computed_sha256,
        artifacts.prose.artifact_id,
        artifacts.prose.computed_sha256,
    ):
        errors.append("CONTEXT PASS does not match current input, record, and prose")

    if cold_pass.verdict != "COLD PASS":
        errors.append("cold verdict is not PASS")
    if cold_pass.mode != "COLD PROSE":
        errors.append("cold reviewer mode is invalid")
    if cold_pass.fork_turns != "none":
        errors.append("cold reviewer did not use fork_turns=none")
    if cold_pass.payload_scope != "prose_only":
        errors.append("cold reviewer received extra context")
    if not cold_pass.reviewer_task or cold_pass.reviewer_task in {
        cold_pass.writer_task,
        context_pass.reviewer_task,
        record_pass.reviewer_task,
    }:
        errors.append("cold review is not a separate fresh task")
    if (cold_pass.prose_id, cold_pass.prose_sha256) != (
        artifacts.prose.artifact_id,
        artifacts.prose.computed_sha256,
    ):
        errors.append("COLD PASS does not match current prose")
    return errors


def author_display_allowed(artifacts: ArtifactSet, passes: PassSet) -> bool:
    return not verify_current_passes(artifacts, passes)
