# TaleWisp agent routing

The main TaleWisp task is the orchestrator. Separate the production route from the calibration laboratory.

## Roles

These names describe logical responsibilities, not custom agent types guaranteed to exist on every host:

- `style_editor`: internally plans and returns finished prose or a precise revision in one generation.
- `lore_researcher`: retrieves canon, manuscript, calibration, and external evidence.
- `vault_curator`: audits vault structure, metadata, links, timelines, and glossaries.
- `continuity_reviewer`: performs a targeted prose review or evaluates training candidates.

All subagents are read-only. Only the main task may save or apply proposals.

## Host-portable dispatch

Before dispatch, inspect the host's available delegation tool and registered agent types. Use the named role as `agent_type` only when that custom type is registered. Otherwise use the supported `default` type, or the host's documented generic type, and state the logical role explicitly in the work packet. Do not create global agent registrations or modify configuration to supply missing types.

The work packet includes the role's responsibility above, the exact requested output, relevant source paths and evidence, permitted read scope, read-only execution, and the rule that only the main task writes. For a writer, include the production INPUT; for an independent reviewer, provide the literal candidate and applicable evidence with a bounded review question. Preserve the same resolved model and reasoning effort in either dispatch route, and verify that the host supports the pair before launching. A generic agent type does not authorize substituting another model or effort.

If the host has no delegation capability, no supported generic agent type, or cannot launch the resolved pair, report the exact missing route and leave its required step unfinished. Do not turn a mandatory independent series-import review into a main-task self-review or self-issued PASS. Optional reviews retain their existing limits; no fallback adds a hidden rewrite loop.

## Model and reasoning selection

Before every dispatch, use the shared [model selection](model-selection.md) resolver. The recommended combinations are `gpt-6.1-sol` medium and high; the built-in default is medium. Explicit high needs no warning. A user's accepted once/project choice may use another supported model or effort. Pass the resolved pair explicitly when launching the agent; do not pin a model in a role file or inherit an unrelated Codex default. A one-dispatch choice is not reused for the next agent.

## Routes

| Request | Default route |
|---|---|
| Advice, brainstorming, scene planning without prose | Main task |
| New prose or continuation | Main compiles INPUT -> one `style_editor` internally plans and returns finished prose |
| Revision of existing prose | Main compiles source + exact author delta -> one `style_editor` returns the complete revision |
| Consequential canon research before writing | `lore_researcher` -> main INPUT -> one `style_editor` |
| User-requested or evidenced high-risk review | Finished prose -> one quick `continuity_reviewer` |
| Style calibration or prompt training | Parallel blind `style_editor` candidates -> one training evaluator -> prompt diagnosis |
| Recurring root-defect investigation | Explicit laboratory diagnostic; generation record and deeper reviewers only when named in the plan |
| Vault organization or import | `vault_curator`; add `lore_researcher` only for entity resolution |
| Apply an accepted change | Main task only, after explicit approval |

## Production INPUT

Read [production-input.md](production-input.md). The main task compiles its one concise packet under that reference's source-resolution and presentation semantics. Resolve consequential alternatives before dispatch.

## One-generation writer contract

The `style_editor` silently constructs the necessary causal and perceptual skeleton inside the same turn. It checks, without returning a separate artifact:

1. entry and first reader-visible meaningful beat;
2. trigger -> perception -> personal meaning -> reaction/action -> consequence -> next focus;
3. motivated attention and first reader access for significant objects;
4. knowledge owners, sources, assertions, and referents;
5. dialogue roles and staging when applicable;
6. consequential physical effects, timing, and boundaries;
7. climax as perceived result -> personal reinterpretation -> immediate impulse -> next action;
8. preservation of the source message and the author's exact delta.

After that internal check, the same response contains finished prose. Production does not request a JSON generation record, `GENERATION RECORD PASS`, artifact IDs, hashes, or a prose-free readiness message.

## Quick post-generation review

Do not start it automatically for every passage. Use one reviewer only when:

- the author asks for a review;
- canon, chronology, knowledge-at-time, identity, or a consequential physical chain is genuinely high risk;
- the main task can name a specific evidenced uncertainty;
- the passage is a training candidate being evaluated.

The reviewer reads the finished prose and relevant evidence once. It returns blockers first and optional style notes separately. It does not demand a complete screenplay, expand harmless micro-details, or trigger hidden rewrites. If a blocker remains, report whether the failure came from the INPUT, prompt mechanism, or literal prose.

## Calibration and prompt-training laboratory

Calibration trains the writer prompt. It is not production QA.

1. Choose one controlled feature or small group of linked hypotheses.
2. Hold author samples and expected style conclusions away from blind candidate writers.
3. Give the same scene contract to two or three candidates with deliberately different prompt variants.
4. Each candidate internally plans and returns one finished passage; no pre-prose record review occurs.
5. After all candidates finish, one evaluator receives the task, candidates, prompt variants, author samples, confirmed rules, and known failure classes.
6. The evaluator identifies which prompt instruction caused each success or failure. Ranking alone is insufficient.
7. Promote a prompt change only after a second scene type or held-out control supports it.
8. Ask the author for another calibration only when the missing evidence is specific and the next sample would distinguish competing prompt hypotheses.

Do not reuse training passages as canon. Do not silently start another competition after a failed round.

## Optional deep diagnostics

The existing `scripts/fiction_gate.py`, compact/full generation records, transition/object/effect ledgers, cold readers, fingerprints, and `author_display_allowed` remain available as laboratory instruments for a recurring root defect. They may be invoked only when an explicit diagnostic plan names the defect and explains what the instrument should reveal.

In that laboratory mode, preserve the existing safety properties:

- exact artifact content and version-bound hashes;
- independent record/prose/cold evidence scopes;
- no ordinary-world inference substituted for missing literal action;
- no hidden opening interaction, unsupported presupposition, missing referent, or ungrounded verification;
- physical source, path, target, state change, sensory source, and reaction when that chain is the object of investigation;
- fresh cold readers with prose-only input when cold reconstruction is explicitly needed.

Passing a laboratory gate proves only that the tested failure class was blocked. It does not by itself prove authorial style or make the gate mandatory for production.

## No hidden loops

- One production dispatch means one generated prose result.
- A quick reviewer does not automatically authorize regeneration.
- A training candidate gets one attempt per prompt variant.
- After failure, diagnose the mechanism before a new run.
- Keep full artifacts at shared paths when a laboratory diagnostic needs them; ordinary production does not create bookkeeping artifacts.
