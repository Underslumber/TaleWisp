# TaleWisp model selection

Recommend **Sol 6.1 medium** and **Sol 6.1 high** for agents. Use `gpt-6.1-sol`, `medium` when the user has not selected another pair and the project has no saved preference. Either recommended pair can be requested without a warning. These recommendations do not establish universal quality rankings or restrict which supported model the user may choose.

## Before dispatch

1. Identify the actual TaleWisp project root, separate from the selected manuscript vault. Resolve its preference through `talewisp_model_selection`. Supply `project_root` explicitly when working in a series subproject; never store a series choice at the shared author vault by accident.
2. Pass a user/caller-selected model or effort as `model` / `effort`. If neither was selected, omit both: an unrelated inherited Codex default is not an explicit TaleWisp choice. If changing to another model leaves effort unspecified, resolve the missing level using the host's supported values rather than guessing.
3. Use the live host's available models and supported efforts for validation. The optional `available_models` input maps exact model IDs to supported effort lists; availability is not implied by a role name or recommendation. If the resolved pair is unavailable, explain the problem and ask for a supported selection; do not silently fall back.
4. If the result needs a choice, show its warning and the three options below through the native user-input panel when available. Continue unrelated work while waiting, but do not dispatch the affected agent without an answer. A preselected option or elapsed time is not an answer.
5. Call the resolver with the selected `choice`, then pass the returned model and effort explicitly to the agent tool. This project setting does not switch the live root model or modify global Codex configuration.

## Warning and exactly three options

> Для агентов TaleWisp рекомендуются Sol 6.1 medium и high. Вы выбрали другой режим. Как применить этот выбор?

| Label | `choice` | Effect |
|---|---|---|
| Не менять | `keep` | Keep the current project default; initially Sol 6.1 medium. |
| Поменять один раз | `once` | Use the requested pair for this single agent dispatch; do not save it as the project default. |
| Поменять для всего проекта | `project` | Save the requested pair for all subsequent agents in this project until the user changes it. |

Describe the current and requested pairs in the question so that **Не менять** is unambiguous. Keep the option labels unchanged. When the user has already explicitly specified once/project scope, apply that answer directly rather than repeating the question. In a calibration matrix with explicit per-candidate models, that scope is already one dispatch per candidate: retain the matrix, do not collapse it to the recommended default.

After **Поменять один раз**, invoke the resolver again for the next agent without carrying forward the previous request or choice. After **Поменять для всего проекта**, use the saved pair without repeating the same warning. A later new choice outside the recommendations still gets the three options. Recommended high/medium requested for one run do not automatically replace a saved project preference.

## Persistence and fallback

Only project-scoped selection writes a preference, at `<project-root>/.talewisp/model-selection.json`. A plain status/resolve call and a once/keep decision must not create that file. Keep the preference separate from author profiles, canon, role definitions and historical calibration evidence. Changing the active vault does not move this setting.

If the MCP tool is unavailable in the current task, use the same local implementation:

```powershell
python plugin/scripts/model_selection.py --project-root "<absolute-project-root>"
```

```powershell
python plugin/scripts/model_selection.py --project-root "<absolute-project-root>" --model gpt-6.1-sol --effort high
```

For a user-approved override, include `--model`, `--effort` and `--choice keep|once|project`. Use the selected project's actual path, not the example path, for another author or series. Corrupt settings are an error to repair, not permission to forget the user's preference.

The resolver supplies a decision; the main TaleWisp agent owns dispatch and the visible conversational warning. It cannot intercept the desktop application's model-menu events. Installed plugins are separate copies: source changes require an installation update and tool/skill reload before their MCP entrypoints change.
