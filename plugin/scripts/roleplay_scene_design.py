"""Private pre-play design. Approval checks causal meaning before actor entry."""
import copy
import hashlib
import json


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def build_input(*, session_id, bundle, actors, frames, purpose, sources):
    if (not isinstance(purpose, dict) or set(purpose) != {"functions", "why", "entry_state", "intended_shift", "open_outcomes"} or
            any(not isinstance(purpose[k], str) or not purpose[k].strip() for k in ("why", "entry_state", "intended_shift")) or
            any(not isinstance(purpose[k], list) or not purpose[k] or any(not isinstance(x, str) or not x.strip() for x in purpose[k]) for k in ("functions", "open_outcomes")) or
            len(set(purpose["open_outcomes"])) < 2):
        raise ValueError("scene purpose must precede design")
    if not isinstance(sources, dict) or not sources or any(not isinstance(v, str) or not v.strip() for v in sources.values()):
        raise ValueError("design requires actual bounded source excerpts")
    leader = next(k for k, v in actors.items() if v["role"] == "leader")
    grounds = {f"actor:{actor}:{g['id']}": g["text"] for actor, frame in frames.items() for g in frame["grounds"]}
    grounds.update({f"actor:{actor}:strivings": " ".join(frame["strivings"]) for actor, frame in frames.items()})
    grounds.update({"source:" + k: v for k, v in sources.items()})
    context = {"bundle": copy.deepcopy(bundle), "actors": copy.deepcopy(actors), "frames": copy.deepcopy(frames),
               "purpose": copy.deepcopy(purpose), "grounds": grounds}
    p = {"schema": "logical-scene-design-input", "session_id": session_id, "role": "leader", "actor_id": leader,
         "based_on_revision": 0, "source_fingerprint": digest(context), "context": context,
         "instruction": "Private planning before play. Goal first. Design a situation whose available opportunity matters to this hero beyond a curious detail. Use full character conditions, not only one current task. Propose source-consistent local trial additions, explicitly marked; no predetermined response, dialogue, emotions or magical effects. Entrances are circumstances, not already played character decisions. A possible stimulus requiring an NPC act must be played later by that NPC. Establish the NPC's concrete present reason for its entry activity and a perceptible path to the opportunity; 'NPC will choose a reason later' is not a causal bridge. Never transfer design/choices/purpose or future possibilities to character knowledge: setup contains only present external facts, not planning language. Do not rely on a future unsolicited offer that has no current cause.",
         "response_schema": {"purpose": "exact context.purpose", "setup": "present external entry facts only; no private plan, intended outcome, conditional future offer or audit",
            "entries": {actor: {"position": "entry position", "activity": "entry activity", "known_setup": ["own accessible entry facts only"]} for actor in frames},
            "interest_bridge": {"grounds": [{"ref": "context.grounds key", "quote": "exact span"}],
                "stimulus": "concrete accessible potential trigger, not a guaranteed future act",
                "importance": "why relevant to this hero and this scene purpose", "uncertainty": "what remains to be tested"},
            "npc_basis": {"goal": "NPC own established aim", "engagement": "concrete entry condition and own reason for activity/possible engagement; not a deferred reason to be invented later", "cost": "cost or boundary"},
            "choices": [{"action": "free hero option", "cost": "price", "result": "possible distinct consequence"}],
            "expected_shift": "testable intended change, not compulsory result", "additions": ["explicit noncanonical staging additions"]}}
    p["packet_binding"] = {"session_id": session_id, "actor_id": leader, "source_fingerprint": p["source_fingerprint"],
                           "based_on_revision": 0, "packet_fingerprint": digest(p)}
    return p


def validate_input(p):
    try:
        body = {k: v for k, v in p.items() if k != "packet_binding"}
        b = p["packet_binding"]
        if (p["schema"] != "logical-scene-design-input" or p["source_fingerprint"] != digest(p["context"]) or
                b != {"session_id": p["session_id"], "actor_id": p["actor_id"], "source_fingerprint": p["source_fingerprint"],
                      "based_on_revision": 0, "packet_fingerprint": digest(body)}):
            raise ValueError("design input binding changed")
    except (KeyError, TypeError) as exc:
        raise ValueError("invalid design input") from exc


def validate_response(p, envelope):
    validate_input(p)
    if not isinstance(envelope, dict) or set(envelope) != {"packet_binding", "design"} or envelope["packet_binding"] != p["packet_binding"]:
        raise ValueError("design response needs exact input binding, not response.turn")
    d = envelope["design"]
    if not isinstance(d, dict) or set(d) != set(p["response_schema"]) or d["purpose"] != p["context"]["purpose"]:
        raise ValueError("design must preserve scene purpose and complete schema")
    def text(x):
        return isinstance(x, str) and bool(x.strip())
    if not text(d["setup"]) or not text(d["expected_shift"]):
        raise ValueError("design needs concrete situation and shift")
    if not isinstance(d["entries"], dict) or set(d["entries"]) != set(p["context"]["frames"]):
        raise ValueError("design entries must cover exactly the characters")
    for entry in d["entries"].values():
        if (not isinstance(entry, dict) or set(entry) != {"position", "activity", "known_setup"} or
                not text(entry["position"]) or not text(entry["activity"]) or not isinstance(entry["known_setup"], list) or not entry["known_setup"] or
                any(not text(x) for x in entry["known_setup"])):
            raise ValueError("invalid character entry projection")
    bridge = d["interest_bridge"]
    if not isinstance(bridge, dict) or set(bridge) != {"grounds", "stimulus", "importance", "uncertainty"} or any(not text(bridge[k]) for k in ("stimulus", "importance", "uncertainty")):
        raise ValueError("design needs explicit causal interest bridge")
    if not isinstance(bridge["grounds"], list) or not bridge["grounds"]:
        raise ValueError("interest bridge needs source grounds")
    for g in bridge["grounds"]:
        if (not isinstance(g, dict) or set(g) != {"ref", "quote"} or not text(g["ref"]) or
                g["ref"] not in p["context"]["grounds"] or not text(g["quote"]) or g["quote"] not in p["context"]["grounds"][g["ref"]]):
            raise ValueError("interest grounds must quote a supplied source")
    hero = next(k for k, v in p["context"]["actors"].items() if v["role"] == "hero")
    if not any(g["ref"].startswith(f"actor:{hero}:") for g in bridge["grounds"]):
        raise ValueError("interest bridge must retain the hero, not only world or NPC facts")
    npc = d["npc_basis"]
    if not isinstance(npc, dict) or set(npc) != {"goal", "engagement", "cost"} or any(not text(v) for v in npc.values()):
        raise ValueError("NPC engagement needs own goal and price")
    options = d["choices"]
    if (not isinstance(options, list) or len(options) < 2 or
            any(not isinstance(x, dict) or set(x) != {"action", "cost", "result"} or any(not text(v) for v in x.values()) for x in options) or
            len({x["action"] for x in options}) != len(options) or len({x["result"] for x in options}) < 2):
        raise ValueError("design must leave distinct choices and consequences")
    if not isinstance(d["additions"], list) or any(not text(x) for x in d["additions"]):
        raise ValueError("design additions must be explicit strings")
    return copy.deepcopy(d)


CHECKS = {"purpose_to_situation", "hero_reason", "npc_reason", "knowledge", "open_choice", "no_forced_outcome"}


def approval_binding(p, envelope):
    d = validate_response(p, envelope)
    return {"input_sha256": digest(p), "design_sha256": digest(d)}


def approve(p, envelope, review):
    binding = approval_binding(p, envelope)
    if (not isinstance(review, dict) or set(review) != {"binding", "verdict", "checks"} or review["binding"] != binding or
            review["verdict"] != "approve" or not isinstance(review["checks"], dict) or set(review["checks"]) != CHECKS or
            any(not isinstance(v, str) or len(v.strip()) < 40 for v in review["checks"].values())):
        raise ValueError("design requires a bound host semantic approval before actors")
    return {"schema": "approved-logical-scene-design", "input": copy.deepcopy(p), "response": copy.deepcopy(envelope), "review": copy.deepcopy(review)}


def materialize(approved):
    if not isinstance(approved, dict) or set(approved) != {"schema", "input", "response", "review"} or approved["schema"] != "approved-logical-scene-design":
        raise ValueError("actors cannot enter before approved scene design")
    if approve(approved["input"], approved["response"], approved["review"]) != approved:
        raise ValueError("approved design changed")
    p = approved["input"]; d = approved["response"]["design"]
    bundle = copy.deepcopy(p["context"]["bundle"]); frames = copy.deepcopy(p["context"]["frames"])
    initial = {}
    for actor, spec in p["context"]["actors"].items():
        if spec["role"] == "leader":
            bundle["role_memory"]["leader"]["situation"] = d["setup"]
            continue
        entry = d["entries"][actor]
        memory = bundle["role_memory"]["hero"] if spec["role"] == "hero" else bundle["role_memory"]["leader"]["npc_memories"][spec["name"]]
        memory["situation"] = " ".join(entry["known_setup"])
        memory["observations"] = copy.deepcopy(entry["known_setup"])
        initial[actor] = {"position": entry["position"], "activity": entry["activity"]}
        frames[actor]["grounds"].append({"id": "approved_trial_entry", "text": " ".join(entry["known_setup"]),
            "provenance": "Explicitly noncanonical approved scene design; not a played event or future response."})
    bundle["physical_staging"] = {"starting_scene": d["setup"], "status": "Noncanonical trial, not source canon"}
    return {"bundle": bundle, "frames": frames, "initial_actor_state": initial, "purpose": copy.deepcopy(p["context"]["purpose"]),
            "private_design": copy.deepcopy(approved)}
