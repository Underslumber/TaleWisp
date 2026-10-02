#!/usr/bin/env python3
"""Project-local, caller-invoked model selection; never changes a running agent."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

DEFAULT = {"model": "gpt-6.1-sol", "effort": "medium"}
RECOMMENDED = [DEFAULT, {"model": "gpt-6.1-sol", "effort": "high"}]
CHOICES = [
    {"id": "keep", "label": "Не менять"},
    {"id": "once", "label": "Поменять один раз"},
    {"id": "project", "label": "Поменять для всего проекта"},
]


class ModelSelectionError(ValueError):
    pass


def _text(value, field):
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise ModelSelectionError(f"{field} must be a non-empty string without surrounding whitespace")
    return value


def _paths(project_root):
    root = Path(project_root).expanduser().resolve()
    if not root.is_dir():
        raise ModelSelectionError(f"Project directory does not exist: {root}")
    directory = root / ".talewisp"
    path = directory / "model-selection.json"
    for candidate in (directory, path):
        if candidate.is_symlink() or (hasattr(candidate, "is_junction") and candidate.is_junction()):
            raise ModelSelectionError(f"Model settings cannot use a symlink or junction: {candidate}")
        if not candidate.resolve().is_relative_to(root):
            raise ModelSelectionError("Model settings path escapes the project")
    return root, directory, path


def _read(project_root):
    root, directory, path = _paths(project_root)
    data = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ModelSelectionError(f"Cannot read model settings {path}: {exc}") from exc
        if not isinstance(data, dict) or type(data.get("schema_version")) is not int or data["schema_version"] != 1:
            raise ModelSelectionError(f"Invalid model settings schema: {path}")
        pair = data.get("selection")
        if not isinstance(pair, dict):
            raise ModelSelectionError(f"Invalid model settings selection: {path}")
        pair = {"model": _text(pair.get("model"), "model"), "effort": _text(pair.get("effort"), "effort")}
    else:
        pair = dict(DEFAULT)
    return root, directory, path, data, pair


def model_status(project_root):
    root, _, path, data, pair = _read(project_root)
    return {"project_root": str(root), "settings_path": str(path), "project_default": pair,
            "source": "saved" if data else "builtin", "recommended": [dict(p) for p in RECOMMENDED]}


def _catalog(available_models):
    if available_models is None:
        return None
    if not isinstance(available_models, dict):
        raise ModelSelectionError("available_models must map models to supported effort lists")
    for model, efforts in available_models.items():
        _text(model, "available model")
        if not isinstance(efforts, list) or not efforts:
            raise ModelSelectionError(f"Supported efforts must be a non-empty list: {model}")
        for effort in efforts:
            _text(effort, "available effort")
    return available_models


def _validate(pair, catalog):
    if catalog is not None and (pair["model"] not in catalog or pair["effort"] not in catalog[pair["model"]]):
        raise ModelSelectionError(f"Unavailable model/effort pair: {pair['model']} / {pair['effort']}")


def resolve_selection(project_root, requested_model=None, requested_effort=None, choice=None, available_models=None):
    root, directory, path, data, current = _read(project_root)
    catalog = _catalog(available_models)
    if choice is not None and choice not in {"keep", "once", "project"}:
        raise ModelSelectionError("choice must be keep, once or project")
    status = model_status(root)
    result = {**status, "status": "ready", "ready": True, "selection": None,
              "scope": "project", "warning": None, "choices": []}
    if choice == "keep" or (requested_model is None and requested_effort is None):
        _validate(current, catalog)
        result["selection"] = current
        return result
    model = current["model"] if requested_model is None else _text(requested_model, "model")
    if catalog is not None and model not in catalog:
        raise ModelSelectionError(f"Unavailable model: {model}")
    effort = requested_effort
    if effort is None:
        if model == current["model"]:
            effort = current["effort"]
        elif (catalog is not None and "medium" in catalog[model]) or (catalog is None and model == DEFAULT["model"]):
            effort = "medium"
        else:
            return {**result, "status": "needs_effort", "ready": False,
                    "warning": "Укажите уровень reasoning effort для выбранной модели.", "scope": None}
    pair = {"model": model, "effort": _text(effort, "effort")}
    _validate(pair, catalog)
    if choice is None and pair not in RECOMMENDED and pair != current:
        return {**result, "status": "awaiting_choice", "ready": False, "scope": None,
                "warning": "Рекомендуются gpt-6.1-sol medium или gpt-6.1-sol high. Выбрана другая модель или уровень reasoning effort; выберите область изменения.",
                "choices": [dict(c) for c in CHOICES]}
    if choice == "project":
        # Preserve extension fields, including fields inside selection.
        data = {**data, "schema_version": 1,
                "selection": {**data.get("selection", {}), **pair}}
        directory.mkdir(exist_ok=True)
        _paths(root)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, delete=False) as stream:
                temporary = Path(stream.name)
                json.dump(data, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            _paths(root)
            os.replace(temporary, path)
        except OSError as exc:
            raise ModelSelectionError(f"Cannot save model settings {path}: {exc}") from exc
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()
        result.update(model_status(root))
    result.update(selection=pair, scope="once" if choice == "once" else ("project" if choice == "project" or pair == current else "once"))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--model")
    parser.add_argument("--effort")
    parser.add_argument("--choice", choices=["keep", "once", "project"])
    parser.add_argument("--available-models-json")
    args = parser.parse_args()
    try:
        catalog = json.loads(args.available_models_json) if args.available_models_json else None
        result = resolve_selection(args.project_root, args.model, args.effort, args.choice, catalog)
    except (ModelSelectionError, json.JSONDecodeError, OSError) as exc:
        result = {"status": "error", "ready": False, "selection": None, "error": str(exc)}
        code = 1
    else:
        code = 0
    sys.stdout.buffer.write((json.dumps(result, ensure_ascii=False) + "\n").encode("utf-8"))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
