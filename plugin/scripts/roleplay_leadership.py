"""Host-only scene movement assessments; references prove delivery, not meaning."""
import copy

INSTRUCTION = (
    "scene_purpose уже задан до запуска: прочитай, зачем сцена нужна истории и какое изменение или раскрытие она проверяет. "
    "Развитие, демонстрация характера, конфликт, изменение отношений могут сочетаться. "
    "Цель сцены отличается от цели героя и от обязательного исхода. "
    "Ведущий отвечает за возникновение ситуации, а не только описание комнаты. "
    "Построй доступный герою повод, связанный с его существующим стремлением или уязвимостью: "
    "что изменилось, почему это может его заинтересовать, между чем он теперь выбирает и что изменится от выбора. "
    "Постановка не равна завязке. Если повод требует поступка NPC, сначала дай ход этому NPC; "
    "не выполняй его поступок за него. После проявления повода оставь решение герою. "
    "Отказ допустим и тоже имеет последствия; не назначай интерес, согласие, дружбу или обучение. "
    "Последствия должны зависеть от принятого действия героя; не разрешай всё независимо от него. "
    "Авторский ориентир не даёт права вводить новую магическую механику, награду или срочность."
    " Этот объект целиком — приватное задание ведущему, не материал response.turn. "
    "В turn возвращай только конкретно воспринимаемую внешнюю постановку или последствия. "
    "План, цель сцены, оценку повода, ожидание и передачу хода не оформляй как action. "
    "Не требуется пересказывать план даже с audience=[]; действия имеют непустую аудиторию. "
    "Следующего участника выбирает host отдельно от твоих событий."
)


def validate_purpose(purpose):
    fields = {"functions", "why", "entry_state", "intended_shift", "open_outcomes"}
    if not isinstance(purpose, dict) or set(purpose) != fields:
        raise ValueError("scene_purpose must precede play: functions, why, entry_state, intended_shift, open_outcomes")
    for key in ("functions", "open_outcomes"):
        if (not isinstance(purpose[key], list) or not purpose[key] or
                any(not isinstance(x, str) or not x.strip() for x in purpose[key])):
            raise ValueError("scene purpose functions/outcomes must be nonempty lists of strings")
    if len(set(purpose["open_outcomes"])) < 2:
        raise ValueError("scene purpose must leave at least two open outcomes")
    if any(not isinstance(purpose[k], str) or not purpose[k].strip() for k in ("why", "entry_state", "intended_shift")):
        raise ValueError("scene purpose needs concrete why, entry state and intended shift")


def packet(state, current_goals):
    frames = copy.deepcopy(state["bundle"]["logical_motivation_frames"])
    for actor, goal in current_goals.items():
        frames[actor]["current_goal"] = goal
    return {"instruction": INSTRUCTION, "accepted_progress": copy.deepcopy(state["logical_scene_history"]),
            "character_frames": frames,
            "scene_purpose": copy.deepcopy(state["bundle"]["logical_scene_purpose"]),
            "review_boundary": "Private host design, not perceived facts or character knowledge."}


def evidence(state):
    hero = next(k for k, v in state["actors"].items() if v["role"] == "hero")
    values = {}
    for event in state["transcript"]:
        if event["kind"] != "inner" and (hero in event.get("audience", []) or event["actor_id"] == hero):
            values[f"event:{event['sequence']}"] = str(event.get("action", event.get("content", event.get("resolution", ""))))
    return values


def validate(state, review):
    required = {"phase", "stimulus", "interest_basis", "options", "hero_actions", "causal_link", "opportunity_id"}
    if not isinstance(review, dict) or set(review) != required:
        raise ValueError("leader scene review needs phase, stimulus, interest_basis, options, hero_actions, causal_link")
    phase = review["phase"]
    if phase not in {"setup", "opportunity", "consequence"}:
        raise ValueError("invalid scene phase")
    if not isinstance(review["causal_link"], str) or not review["causal_link"].strip():
        raise ValueError("scene review needs a semantic causal assessment")
    available = evidence(state)
    def quotes(items, source):
        if not isinstance(items, list) or not items:
            raise ValueError("scene evidence cannot be empty")
        for item in items:
            if (not isinstance(item, dict) or set(item) != {"ref", "quote"} or
                    not isinstance(item["ref"], str) or item["ref"] not in source or
                    not isinstance(item["quote"], str) or not item["quote"].strip() or
                    item["quote"] not in source[item["ref"]]):
                raise ValueError("scene evidence must quote an accessible exact source")
    quotes(review["stimulus"], available)
    if not isinstance(review["options"], list) or not isinstance(review["hero_actions"], list):
        raise ValueError("scene options and hero actions must be lists")
    if phase == "opportunity":
        used = {x["ref"] for entry in state["logical_scene_history"] if entry["assessment"]["phase"] == "opportunity"
                for x in entry["assessment"]["stimulus"]}
        if all(x["ref"] in used for x in review["stimulus"]):
            raise ValueError("opportunity needs new accepted evidence, not recycled progress credit")
        hero = next(k for k, v in state["actors"].items() if v["role"] == "hero")
        frame = state["bundle"]["logical_motivation_frames"][hero]
        grounds = {f"ground:{x['id']}": x["text"] for x in frame["grounds"]}
        grounds["strivings"] = " ".join(frame["strivings"])
        quotes(review["interest_basis"], grounds)
        options = review["options"]
        if len(options) < 2 or any(not isinstance(x, dict) or set(x) != {"action", "consequence"} or
                                  any(not isinstance(v, str) or not v.strip() for v in x.values()) for x in options):
            raise ValueError("opportunity needs at least two meaningful options and consequences")
        if len({x["action"] for x in options}) != len(options) or len({x["consequence"] for x in options}) < 2:
            raise ValueError("options must differ in action and consequence")
    elif review["interest_basis"] != [] or review["options"] != []:
        raise ValueError("only opportunity supplies interest and options")
    if phase == "consequence":
        opportunity = next((x for x in state["logical_scene_history"] if x["id"] == review["opportunity_id"] and x["assessment"]["phase"] == "opportunity"), None)
        if opportunity is None:
            raise ValueError("consequence requires an accepted opportunity")
        latest = opportunity["revision"]
        hero_events = {f"event:{x['sequence']}": available[f"event:{x['sequence']}"] for x in state["transcript"]
                       if x["speaker_role"] == "hero" and x["kind"] in {"action", "communication"} and x["revision"] > latest}
        quotes(review["hero_actions"], hero_events)
        action_seq = max(int(x["ref"].split(":")[1]) for x in review["hero_actions"])
        if not any(int(x["ref"].split(":")[1]) >= action_seq for x in review["stimulus"]):
            raise ValueError("consequence evidence must follow the quoted hero action")
        def credit_key(item):
            return (item["opportunity_id"], frozenset(x["ref"] for x in item["hero_actions"]),
                    frozenset(x["ref"] for x in item["stimulus"]))
        if any(entry["assessment"]["phase"] == "consequence" and
               credit_key(entry["assessment"]) == credit_key(review) for entry in state["logical_scene_history"]):
            raise ValueError("consequence already credited for this opportunity, hero action and result")
        prior = [entry for entry in state["logical_scene_history"] if entry["assessment"]["phase"] == "consequence"
                 and entry["assessment"]["opportunity_id"] == review["opportunity_id"]]
        used = {x["ref"] for entry in prior for x in entry["assessment"]["stimulus"]}
        cutoff = max((entry["revision"] for entry in prior), default=-1)
        events = {f"event:{x['sequence']}": x for x in state["transcript"]}
        if not any(x["ref"] not in used and events[x["ref"]]["sequence"] >= action_seq and
                   events[x["ref"]]["revision"] > cutoff for x in review["stimulus"]):
            raise ValueError("consequence requires a new result, not rearranged prior evidence")
    elif review["hero_actions"] != []:
        raise ValueError("hero action evidence belongs to consequence")
    if phase != "consequence" and review["opportunity_id"] is not None:
        raise ValueError("only consequence references an opportunity")
    return copy.deepcopy(review)
