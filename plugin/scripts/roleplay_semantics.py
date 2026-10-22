"""Small source-linked semantic kernel and causal event validators.

Validation proves references and visibility constraints only; semantic fit is
still checked by the host against the complete source packet.
"""
from __future__ import annotations
import re
from typing import Any

class SemanticsError(ValueError): pass

ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
HERO_SLOTS = {"goal", "stake", "value", "limit", "knowledge", "body", "resource"}
SCENE_SLOTS = {"affordance", "condition", "tension", "not_established"}
FORBIDDEN = {"outcome", "required_reaction", "emotion", "hero_choice", "focus"}

def _scene_entry(ref: dict[str, Any], scene_context: dict[str, Any]) -> Any:
    if not isinstance(scene_context, dict): raise SemanticsError("scene_context must be an object")
    loc=ref.get("scene_context")
    if not isinstance(loc,dict) or set(loc)-{"field","index"}:
        raise SemanticsError("scene_context ref must contain field and optional index")
    field=loc.get("field")
    if not isinstance(field,str) or field not in scene_context: raise SemanticsError("unknown scene_context field")
    entries=scene_context.get(field)
    idx=loc.get("index",0)
    if type(idx) is not int or idx<0: raise SemanticsError("scene_context index must be a non-negative integer")
    if isinstance(entries,list):
        if idx>=len(entries): raise SemanticsError("scene_context index is out of range")
        entry=entries[idx]
    else:
        if idx!=0: raise SemanticsError("single scene_context field only accepts index 0")
        entry=entries
    if not isinstance(entry,dict) or not isinstance(entry.get("value"),str) or not entry["value"].strip():
        raise SemanticsError("scene_context refs must point to declarations with a non-empty value")
    return entry

def hero_ref_accessible(ref: Any, inventory: dict[str,Any], scene_context: dict[str,Any]) -> bool:
    """Whether a ref is safe to show to the hero, regardless of kernel layer."""
    if not isinstance(ref,dict): return False
    if set(ref)=={"fact_id"}:
        facts={f.get("id"):f for f in inventory.get("facts",[]) if isinstance(f,dict) and isinstance(f.get("id"),str)}
        fact=facts.get(ref.get("fact_id"))
        return bool(fact and fact.get("status")=="active" and "hero" in fact.get("known_to",[]) and "hero" in fact.get("required_roles",[]))
    if set(ref)=={"scene_context"}:
        loc=ref["scene_context"]
        if not isinstance(loc,dict) or loc.get("field")=="leader_only_context": return False
        try: _scene_entry(ref,scene_context)
        except (SemanticsError,TypeError,KeyError): return False
        return True
    return False

def validate_kernel(kernel: Any, inventory: dict[str, Any], scene_context: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(inventory,dict) or not isinstance(scene_context,dict): raise SemanticsError("inventory and scene_context must be objects")
    if not isinstance(kernel, list) or not kernel or len(kernel) > 20: raise SemanticsError("runtime.kernel must contain 1-20 grounded items")
    facts={f.get("id"):f for f in inventory.get("facts",[]) if isinstance(f,dict) and isinstance(f.get("id"),str)}
    unknown_records={u.get("id"):u for u in inventory.get("unknowns",[]) if isinstance(u,dict) and isinstance(u.get("id"),str)}
    normalized=[]; ids=set()
    for raw in kernel:
        if not isinstance(raw,dict): raise SemanticsError("kernel item must be an object")
        ident=raw.get("id"); layer=raw.get("layer"); slot=raw.get("slot")
        if not isinstance(ident,str) or not ID.fullmatch(ident) or ident in ids: raise SemanticsError("kernel IDs must be unique valid identifiers")
        ids.add(ident)
        if not isinstance(layer,str) or not isinstance(slot,str): raise SemanticsError(f"invalid kernel layer/slot: {layer}/{slot}")
        if slot in FORBIDDEN: raise SemanticsError(f"forbidden kernel slot: {slot}")
        allowed=HERO_SLOTS if layer=="hero" else SCENE_SLOTS if layer=="scene" else {"npc"} if layer=="leader" else set()
        if slot not in allowed: raise SemanticsError(f"invalid kernel layer/slot: {layer}/{slot}")
        ref=raw.get("ref")
        if not isinstance(ref,dict): raise SemanticsError(f"kernel item {ident} needs a ref")
        target_fact=None
        if set(ref)=={"unknown_id"}:
            if slot!="not_established" or not isinstance(ref.get("unknown_id"),str) or ref.get("unknown_id") not in unknown_records: raise SemanticsError(f"unknown_id ref is allowed only for a declared not_established item: {ident}")
            unknown=unknown_records[ref["unknown_id"]]
            if not isinstance(unknown.get("gap"),str) or not unknown["gap"].strip() or not isinstance(unknown.get("blocks_when"),str) or not unknown["blocks_when"].strip(): raise SemanticsError(f"unknown {ident} must include gap and blocks_when")
            target_fact=None
        elif set(ref)=={"fact_id"}:
            if not isinstance(ref.get("fact_id"),str): raise SemanticsError(f"fact_id must be a string: {ident}")
            target_fact=facts.get(ref["fact_id"])
            if slot=="not_established": raise SemanticsError(f"not_established must use typed unknown_id ref: {ident}")
            if target_fact is None or target_fact.get("status")!="active": raise SemanticsError(f"kernel ref must identify an active fact: {ident}")
            if layer=="hero" and (target_fact is None or "hero" not in target_fact.get("known_to",[]) or "hero" not in target_fact.get("required_roles",[])):
                raise SemanticsError(f"hero kernel ref must be active, hero-known, and hero-projected: {ident}")
        elif set(ref)=={"scene_context"}:
            _scene_entry(ref,scene_context)
        else: raise SemanticsError(f"kernel item {ident} must reuse a fact or scene_context declaration")
        holders=raw.get("holder",["leader"]); links=raw.get("links",[])
        if not isinstance(holders,list) or not holders or any(not isinstance(h,str) for h in holders): raise SemanticsError(f"invalid holders in {ident}")
        if (layer=="hero" or "hero" in holders) and not hero_ref_accessible(ref,inventory,scene_context): raise SemanticsError(f"hero-visible kernel item has a private or unresolved ref: {ident}")
        if slot=="not_established" and (layer=="hero" or "hero" in holders): raise SemanticsError(f"not_established is leader-only: {ident}")
        if not isinstance(links,list): raise SemanticsError(f"links must be a list in {ident}")
        normalized.append({**raw,"holder":holders,"links":links})
    byid={x["id"]:x for x in normalized}; actors={x["id"] for x in normalized if x["layer"]=="leader" and x["slot"]=="npc"}
    for item in normalized:
        for link in item["links"]:
            if not isinstance(link,dict) or set(link)!={"rel","to"} or link.get("rel") not in {"threatens","enables","limits","conditions","informs"} or not isinstance(link.get("to"),str) or link["to"] not in byid: raise SemanticsError(f"invalid link in {item['id']}")
    inbound={link["to"] for item in normalized for link in item["links"]}
    for item in normalized:
        for h in item["holder"]:
            if h not in {"hero","leader"} and (not h.startswith("npc:") or h[4:] not in actors): raise SemanticsError(f"undeclared or invalid holder in {item['id']}")
        if item["slot"]=="tension" and not any(byid[l["to"]]["layer"]=="hero" and byid[l["to"]]["slot"] in {"goal","stake","value"} for l in item["links"]): raise SemanticsError(f"tension {item['id']} must link to a hero goal, stake, or value")
        if item["slot"]=="condition" and (not isinstance(item.get("defeated_by"),list) or not item["defeated_by"] or any(not isinstance(v,str) or not v.strip() for v in item["defeated_by"])): raise SemanticsError(f"condition {item['id']} needs defeated_by perceiver classes")
        if item["slot"]=="npc":
            # NPC motive/access references are existing grounded scene_context declarations.
            for key in ("motive_ref","access_ref"):
                loc=item.get(key)
                if not isinstance(loc,dict) or set(loc)!={"scene_context"} or not isinstance(loc["scene_context"],dict): raise SemanticsError(f"NPC {item['id']} needs grounded {key}")
                field=loc["scene_context"].get("field")
                if field!="leader_only_context": raise SemanticsError(f"NPC {item['id']} has invalid {key}")
                try: _scene_entry(loc,scene_context)
                except SemanticsError as exc: raise SemanticsError(f"NPC {item['id']} has invalid {key}") from exc
        if item.get("background") not in (None,True,False): raise SemanticsError(f"background must be boolean in {item['id']}")
        if not item.get("background") and not item["links"] and item["id"] not in inbound: raise SemanticsError(f"kernel item {item['id']} is disconnected")
    if all(x.get("background") for x in normalized): raise SemanticsError("kernel cannot consist entirely of background items")
    hero_anchors={x["id"] for x in normalized if x["layer"]=="hero" and x["slot"] in {"goal","stake","value"} and not x.get("background")}
    scene_anchors={x["id"] for x in normalized if x["layer"]=="scene" and x["slot"] in {"affordance","condition","tension"} and not x.get("background")}
    if not hero_anchors: raise SemanticsError("kernel requires an active hero goal, stake, or value")
    if not scene_anchors: raise SemanticsError("kernel requires an active scene affordance, condition, or tension")
    if not any((source in hero_anchors and link["to"] in scene_anchors) or (source in scene_anchors and link["to"] in hero_anchors) for source,node in byid.items() for link in node["links"]): raise SemanticsError("kernel requires a relational bridge between a hero anchor and scene anchor")
    return normalized

def project_kernel(kernel: list[dict[str,Any]], role: str, *, inventory: dict[str,Any] | None = None,
                   scene_context: dict[str,Any] | None = None,
                   unknowns: list[dict[str,Any]] | None = None,
                   suppressed_fact_ids: set[str] | None = None) -> list[dict[str,Any]]:
    if role not in {"leader","hero","formatter"}: raise SemanticsError("unknown kernel role")
    if role=="formatter": return []
    suppressed_fact_ids=suppressed_fact_ids or set()
    inventory=inventory or {}; context=scene_context or {}
    visible=set()
    for x in kernel:
        if not isinstance(x,dict) or not isinstance(x.get("id"),str) or not isinstance(x.get("holder",["leader"]),list): continue
        if not isinstance(x.get("ref"),dict): continue
        if role not in x.get("holder",["leader"]) or (role=="hero" and x.get("layer") not in {"hero","scene"}): continue
        ref=x.get("ref",{})
        if ref.get("fact_id") in suppressed_fact_ids: continue
        if role=="hero" and not hero_ref_accessible(ref,inventory,context): continue
        if ref.get("unknown_id") and (role=="hero" or x.get("slot")!="not_established"): continue
        visible.add(x["id"])
    facts={f.get("id"):f for f in (inventory or {}).get("facts",[]) if isinstance(f,dict)}
    unknown_map={u.get("id"):u for u in (unknowns or inventory.get("unknowns",[])) if isinstance(u,dict)}
    def text_for(item):
        ref=item.get("ref",{})
        if "fact_id" in ref: return facts.get(ref["fact_id"],{}).get("claim")
        if "unknown_id" in ref: return None
        value=_scene_entry(ref,context)
        return value.get("value") if isinstance(value,dict) else None
    result=[]
    for x in kernel:
        if not isinstance(x,dict) or x.get("id") not in visible: continue
        entry={"id":x["id"],"layer":x["layer"],"slot":x["slot"],"scope":"source-backed entry context; later observations, consequences, and accepted character changes govern current state","links":[l for l in x.get("links",[]) if isinstance(l,dict) and l.get("to") in visible]}
        if "unknown_id" in x.get("ref",{}):
            unknown=unknown_map.get(x["ref"]["unknown_id"])
            if unknown: entry["not_established"]={"gap":unknown["gap"],"blocks_when":unknown["blocks_when"]}
        else: entry["text"]=text_for(x)
        if role=="leader" and x["slot"]=="npc":
            entry["motive"]=_scene_entry(x["motive_ref"],context)["value"]
            entry["access"]=_scene_entry(x["access_ref"],context)["value"]
        result.append(entry)
    return result

def validate_event(event: Any, turns: list[dict[str,Any]], kernel: list[dict[str,Any]]) -> dict[str,Any]:
    if not isinstance(event,dict): raise SemanticsError("event must be an object")
    if not isinstance(turns,list) or any(not isinstance(t,dict) for t in turns): raise SemanticsError("turns must be a list of objects")
    if not isinstance(kernel,list) or any(not isinstance(x,dict) for x in kernel): raise SemanticsError("kernel must be a list of objects")
    eid=event.get("id")
    if not isinstance(eid,str) or not ID.fullmatch(eid) or any(t.get("event",{}).get("id")==eid for t in turns): raise SemanticsError("event id must be unique and valid")
    if not isinstance(event.get("origin"),str) or event.get("origin") not in {"npc","environment","external"}: raise SemanticsError("invalid event origin")
    cause=event.get("cause"); access=event.get("access")
    if not isinstance(cause,dict) or not isinstance(cause.get("kind"),str) or cause.get("kind") not in {"kernel","prior_event","hero_action","offscreen","accident","hidden"}: raise SemanticsError("event cause is required")
    prior=[t.get("event",{}).get("id") for t in turns]
    if cause["kind"]=="kernel" and (not isinstance(cause.get("ref"),str) or cause.get("ref") not in {x["id"] for x in kernel}): raise SemanticsError("event cause ref must identify a kernel item")
    if cause["kind"]=="prior_event" and (not isinstance(cause.get("ref"),str) or cause.get("ref") not in set(prior)): raise SemanticsError("event cause ref must identify a prior local event")
    if cause["kind"]=="hero_action":
        ref=cause.get("ref")
        if not isinstance(ref,str) or not ref.startswith("turn:") or not ref[5:].isdigit(): raise SemanticsError("hero_action cause ref must use turn:<number>")
        index=int(ref[5:])-1
        if index<0 or index>=len(turns) or not turns[index].get("hero_action"): raise SemanticsError("hero_action cause ref must identify a prior local hero action")
    if cause["kind"] in {"hidden","offscreen","accident"}:
        basis=cause.get("basis"); detail=cause.get("detail")
        if not isinstance(detail,str) or not detail.strip() or not isinstance(basis,dict) or set(basis)!={"kind","ref"}: raise SemanticsError("hidden/offscreen/accident cause needs private detail and a typed basis")
        kind,ref=basis.get("kind"),basis.get("ref")
        if kind=="kernel": valid=isinstance(ref,str) and ref in {x["id"] for x in kernel}
        elif kind=="prior_event": valid=isinstance(ref,str) and ref in set(prior)
        elif kind=="hero_action":
            valid=isinstance(ref,str) and ref.startswith("turn:") and ref[5:].isdigit()
            if valid:
                idx=int(ref[5:])-1; valid=0<=idx<len(turns) and bool(turns[idx].get("hero_action"))
        else: valid=False
        if not valid: raise SemanticsError("cause basis must identify an existing local kernel item, prior event, or hero action")
    if (not isinstance(access,dict) or not isinstance(access.get("channel"),str) or access.get("channel") not in {"sight","sound","smell","touch","trace","told"}
            or not isinstance(access.get("via"),str) or access.get("via") not in ({x["id"] for x in kernel}|set(prior))
            or not isinstance(access.get("detail"),str) or not access["detail"].strip()): raise SemanticsError("event access needs a valid channel, kernel/prior-event via, and physical/perceptual detail")
    ps=event.get("perceivers",[])
    if not isinstance(ps,list) or any(p!="hero" and (not isinstance(p,str) or not p.startswith("npc:")) for p in ps): raise SemanticsError("invalid event perceivers")
    actors={x["id"] for x in kernel if x["layer"]=="leader" and x["slot"]=="npc"}
    if any(p.startswith("npc:") and p[4:] not in actors for p in ps): raise SemanticsError("event names an undeclared NPC perceiver")
    if event["origin"]=="npc" and (not isinstance(event.get("actor_id"),str) or event.get("actor_id") not in actors): raise SemanticsError("NPC-origin event must identify a grounded NPC actor")
    rel=event.get("relevance")
    if rel!="ambient" and (not isinstance(rel,list) or not rel or any(not isinstance(x,str) or not ID.fullmatch(x) or x not in {k["id"] for k in kernel} for x in rel)):
        raise SemanticsError("event relevance must be ambient or a non-empty list of existing kernel IDs")
    obs=event.get("observations",[])
    if not isinstance(obs,list) or any(not isinstance(x,str) or not x.strip() for x in obs): raise SemanticsError("event observations must be a list of nonempty strings")
    if "hero" in ps and (not obs or any(x not in (event.get("revealed_to_hero") or []) for x in obs)): raise SemanticsError("hero perceiver requires observations bound to revealed_to_hero")
    if "hero" not in ps and obs: raise SemanticsError("NPC-only event cannot carry hero observations")
    return event

def project_event_for_hero(event: Any) -> dict[str,Any] | None:
    """Allowlist observed event identity and observations; discard private fields."""
    if not isinstance(event,dict) or "hero" not in event.get("perceivers",[]): return None
    observations=event.get("observations",[]); revealed=event.get("revealed_to_hero",[])
    if not isinstance(observations,list) or not isinstance(revealed,list) or not observations or any(x not in revealed for x in observations): return None
    return {"id":event["id"],"observations":list(observations)}

def validate_stimulus(ref: Any, turns: list[dict[str,Any]], current_event: dict[str,Any] | None) -> Any:
    if ref=="own_initiative": return ref
    candidates=([current_event] if current_event else [])+[t.get("event") for t in turns if t.get("event")]
    event=next((e for e in candidates if e and e.get("id")==ref),None)
    if not event or "hero" not in event.get("perceivers",[]): raise SemanticsError("stimulus_ref must identify a current or prior event perceived by the hero")
    return ref

def validate_npc_memory(update: dict[str,Any], turns: list[dict[str,Any]], current_event: dict[str,Any] | None) -> None:
    holder=update.get("holder","world")
    if holder=="world": return
    basis=update.get("basis_event"); candidates=([current_event] if current_event else [])+[t.get("event") for t in turns if t.get("event")]
    if not isinstance(holder,str) or not holder.startswith("npc:") or not isinstance(basis,str) or not any(e and e.get("id")==basis and holder in e.get("perceivers",[]) for e in candidates): raise SemanticsError("NPC memory basis_event must be perceived by that NPC")
