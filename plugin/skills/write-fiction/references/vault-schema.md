# TaleWisp vault schema v0.4

Store source-of-truth content as Markdown with YAML frontmatter. Obsidian must remain able to open and edit every canonical file without TaleWisp.

## Common properties

```yaml
---
type: scene
title: Глава 1, сцена 1
series: "[[Серия]]"
book: "[[Книга 1]]"
canon_status: confirmed
story_time: "День 1, вечер"
pov: "[[Алиса]]"
characters: ["[[Алиса]]", "[[Борис]]"]
locations: ["[[Старый дом]]"]
previous: "[[Пролог]]"
---
```

Use `type` values: `author-profile`, `series`, `series-brief`, `book`, `book-brief`, `chapter`, `scene`, `character`, `location`, `organization`, `item`, `glossary`, `timeline-event`, `plot-thread`, `style-profile`, `style-calibration`, or `illustration`.

Character cards may have flat `storyart_project_path`, `storyart_style_pack`,
`storyart_character_id`, and `storyart_character_name` fields for an external
visual identity. These fields do not change canon status or imply art approval.
An `illustration` note references its exact approved StoryArt generation and
image SHA-256, plus wikilinks to characters, scenes, event anchors, and other
story targets. Pending candidates remain outside the canonical art catalog.

Use `canon_status` values:

- `confirmed`: established source of truth.
- `draft`: planned or uncertain information.
- `proposal`: AI or author proposal not yet accepted.
- `retired`: previously valid information retained for history.

## Temporal facts

Do not overwrite a character's earlier state. Record changes with explicit scope:

```yaml
facts:
  - value: "Не имеет шрама"
    valid_until: "Книга 1, глава 12"
  - value: "Шрам над правой бровью"
    valid_from: "Книга 1, глава 12"
```

When exact dates do not exist, use stable narrative coordinates such as book, chapter, scene, or named event.

## Knowledge and secrets

Represent knowledge separately from objective truth:

```yaml
knowledge:
  - fact: "Король жив"
    known_by: ["[[Алиса]]"]
    learned_at: "[[Глава 8, сцена 2]]"
```

Do not expose a secret to generation before the viewpoint character's `learned_at` point.

## Setup state

Use `setup_status` for onboarding documents:

- `empty`: starter template without confirmed information.
- `draft`: populated but not yet approved.
- `confirmed`: reviewed and accepted by the author.

Do not infer approval from a filled file or from an AI-generated analysis.

## Author profile

Keep the author profile focused on collaboration:

- primary goals and project stage;
- protected elements and unwanted interventions;
- preferred assistant role and feedback format;
- workflow triggers in the form condition -> priority -> action -> prohibition.

Do not collect unrelated personal information.

## Style profiles

A style profile records observations rather than generic adjectives. Separate the layers with `profile_kind`:

- `author-voice`: stable authorial choices supported by representative samples;
- `genre-contract`: genre expectations and project-specific genre rules;
- `narrative-mode`: viewpoint, tense, distance, access to thoughts, and information limits;
- `index`: links to the applicable profiles.

```yaml
---
type: style-profile
profile_kind: author-voice
scope: series
canon_status: confirmed
setup_status: confirmed
sample_scenes: ["[[Пролог]]", "[[Глава 2, сцена 3]]"]
---
```

For each observation record evidence, scope, confidence, preservation rule, and exceptions. Do not label a first-person perspective constraint or a LitRPG system mechanic as an author-wide trait without cross-sample evidence.

For requested profile systematization, use [style-contract.md](style-contract.md) and the [draft profile template](../templates/style-profile.md). Give mechanisms stable IDs shared by writer and evaluator; keep rule status, empirical confidence, and author acceptance separate. Record literal examples, false-positive proxies, exceptions, and unknowns. Existing confirmed profiles are preserved until an author accepts their proposed revision. This Markdown structure is documentation, not a new MCP or parser contract.

## Style calibration

Use `style-calibration` for interactive mini-scene rounds. Record scene type, controlled parameters, correction ratio, hypotheses, confirmed rules, rejected hypotheses, and unresolved preferences.

Require at least action, description, and dialogue. Recommend five rounds by adding interiority and a mixed scene. A rule becomes stable only after it recurs in at least two different scene types or matches representative manuscript evidence.

Treat correction ratios as progress indicators, not canon or quality scores. Calibration conclusions remain drafts until the author approves a proposal to update the relevant style layer.

## Creative briefs

Use `series-brief` for the series promise, themes, world pressure, recurring mechanics, boundaries, and destination. Use `book-brief` for the protagonist's starting state, book goal, opposing force, stakes, mandatory scenes, ending effect, and emotional trajectory.

Reader effects must describe escalation and observable scene evidence, not only labels such as “dark” or “moving”.

## Links and paths

Use Obsidian wikilinks for story entities. Prefer unique filenames inside a vault. If names collide, link with a relative path such as `[[02 Мир/Персонажи/Алиса]]`.
