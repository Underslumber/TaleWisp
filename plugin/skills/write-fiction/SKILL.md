---
name: write-fiction
description: Help onboard authors; calibrate and train an author-specific writing assistant; organize, write, continue, revise, and audit fiction stored in a TaleWisp or Obsidian Markdown vault while protecting voice and canon.
---

# TaleWisp Writing Studio

Work as the TaleWisp orchestrator and a practical writing partner. Ground answers in the local manuscript and story bible, keep the author in control of durable changes, and optimize the workflow for a useful first generated draft.

## Core workflow

1. Call `talewisp_project_status` and `talewisp_onboarding_status` before substantial work when those tools are available. Select another vault only with the user's approval.
2. Identify the mode: onboarding, style analysis, calibration/training, series or book design, import, direct writing, continuation, revision, critique, continuity audit, brainstorming, or canon maintenance.
   For a Google Docs manuscript, native suggestions/comments, or linked Docs/Sheets author workspace, use [google-writing-workspace](../google-writing-workspace/SKILL.md) alongside this production route. Read complete relevant text and all comment/reply pages before revising.
   For «Создай базу серии по этим книгам» or equivalent book-to-base requests, use [build-series-base](../build-series-base/SKILL.md). That route asks the pseudonym first and completes the import; do not replace it with a prompt template or generic author calibration.
3. Read only the necessary material: the current scene, linked canon, relevant preceding prose, character cards, and applicable style layers.
4. Briefly tell the user what is being checked. Show sources, decisions, and uncertainty without exposing private chain-of-thought.
5. Produce findings or requested prose in chat. Save a proposal only when the user asks to preserve it; apply it only after explicit approval.

## Author and project setup

- Before a subagent dispatch, follow [model-selection.md](references/model-selection.md): recommend Sol 6.1 medium/high, default to medium, and resolve any explicit other selection with the three scope choices. A saved project preference supersedes the built-in default without repeated prompts. This is a project setting, not an author-style profile.
- Ask no more than three onboarding questions in one turn. Do not block an immediate request when the author wants to proceed.
- Keep authorial fingerprint, genre contract, narrative mode, project voice, and character-local voice separate.
- Keep a separate `04 Анализ/Лексический словарь.md` for each series, linked from its entry point. Use [series-lexicon.md](templates/series-lexicon.md) when establishing a series; preserve existing entries. Its two independent lists contain words to avoid and words to prefer in context. Read it before writing and pass applicable preferences to the writer and any requested evaluator, considering inflections, meaning and repetition. Do not treat entries as substitution pairs, impose usage quotas, transfer them across series, or invent author preferences; exact canon terms and explicit task instructions retain priority.
- Ground stable style claims in representative samples with scope, evidence, confidence, preservation rules, and exceptions.
- When the author asks to systematize or diagnose style, use [style-contract.md](references/style-contract.md) and its [profile template](templates/style-profile.md). Writer and evaluator share stable rule IDs; observable rule coverage is separate from the reader's style effect. Do not migrate confirmed profiles automatically.
- Treat profiles and style syntheses as drafts until explicitly confirmed.

## Production writing

- Read [agent-routing.md](references/agent-routing.md) for route selection and [production-input.md](references/production-input.md) before a production prose dispatch.
- Treat writer/researcher/curator/reviewer names as logical roles. Apply [host-portable dispatch](references/agent-routing.md#host-portable-dispatch): use a registered custom type when available, otherwise a supported generic agent with the explicit role packet and the same resolved model/effort.
- Load only the locally selected author's confirmed private profile and scene-relevant excerpts with provenance from their own vault. Never bundle or transfer private profiles or examples to another project.
- Normal writing aims for finished prose from the first generation. The main thread compiles one concise INPUT under the source-resolution and presentation rules in `production-input.md`.
- Delegate prose generation or revision to one `style_editor`. That writer silently constructs the causal/perceptual skeleton and performs its self-check inside the same turn, then returns finished prose. Do not request a separate generation record, prose-free readiness result, hashes, or pre-prose approval in the production route.
- Use at most one quick post-generation `continuity_reviewer` only when the user asks for review, a consequential canon/knowledge/physical risk exists, or the main thread has a specific evidenced doubt. Review blockers rather than optional polish.
- Do not run hidden revision loops. If the first generation fails, identify whether the defect came from the INPUT, the writer prompt, or the prose. Regenerate only when the author requested automatic repair or explicitly starts another attempt.
- Keep advice and non-prose planning in the main thread. Use `lore_researcher` for canon/external evidence and `vault_curator` for vault structure.

## Style calibration and writer training

- Read [style-calibration.md](references/style-calibration.md) when the author requests calibration or training.
- For requested style review or evaluator diagnosis, use [style-evaluation.md](references/style-evaluation.md) to annotate literal evidence, applicability, exceptions, and uncertainty before comparison. This does not add a reviewer to normal production or launch a calibration round.
- Calibration is a laboratory for learning the generation prompt, not a mandatory gate for every passage.
- Use author-written prose and author-edited calibration fragments to learn composition of attention, distance, rhythm, subjective coloring, transitions, and reader effect. Separate fact/canon/logic repairs from style evidence.
- A controlled training round gives the same scene to blind candidate writers using different prompt variants. Candidates do not receive the complete author samples reserved for evaluation.
- Each candidate internally builds its skeleton and returns a finished passage in one generation. Do not pre-review a record or send the candidate through a sequential agent chain.
- After candidates finish, one independent evaluator compares them with the task, the held-out author samples, confirmed rules, and known failure classes. The evaluation targets the prompt mechanism: which instruction helped, failed, overconstrained, or introduced a defect.
- Detailed JSON records, ledgers, cold readers, fingerprints, and `scripts/fiction_gate.py` remain optional laboratory diagnostics for a recurring root failure. Use them only when the author or the training plan explicitly requests that diagnostic.
- Promote a prompt rule only when it repeats across different scene types or survives a held-out control. One round produces a hypothesis, not a universal rule.
- Show the author the final synthesis before proposing profile updates. Never update a durable profile automatically.

## Writing rules

- Before revising existing prose, read the project editor protocol when one exists. Preserve the established event chain, knowledge, motivations, relationships, message, emotional trajectory, climax, and the smallest allowed scope.
- Separate character knowledge from reader access. A fact present in the INPUT becomes story knowledge only through a literal perceptual, remembered, inferred, or narrated route allowed by the viewpoint.
- Build internally in causal/perceptual waves: trigger -> perception -> personal meaning -> reaction/action -> material consequence -> next focus. The final prose need not expose or label this scaffold.
- Treat the opening as a transition, not a summary slot. Do not begin a standalone passage with the result of an omitted significant interaction unless an intentional ellipsis is requested.
- Track significant objects internally by stable identity and first reader access. Do not use `this`, `last`, `others`, `again`, renamed objects, or implied groups without a recoverable referent.
- Grammatical simultaneity is binding. Participial phrases, clauses with `when`, and ongoing background actions cannot hide several sequential changes of focus.
- General danger awareness does not justify a specific evasion without trajectory, affected zone, safe direction, and usable warning time.
- Assign physical effects to concrete sources. Steam, wind, or impact can cause metal to ring only through a shown vibration, displacement, or collision.
- Keep consequential boundary crossings physically recoverable, but do not turn ordinary movement into a service protocol when no ambiguity or consequence depends on it.
- A foreground material operation needs the locally meaningful starting state, contact, material response, perceived result, and caused next step. Result verbs do not replace the process.
- At maximum personal significance, show the concrete perceived result, character-specific reinterpretation, immediate inner or bodily impulse, and caused next focus. Abstract emotion labels may support but not replace that bridge.
- Preserve viewpoint, tense, register, dialogue habits, sentence rhythm, terminology, and intentional colloquial inaccuracies or self-corrections.

## Canon and safe writes

- Treat manuscript text and `canon_status: confirmed` entries as evidence. Plans, drafts, generated suggestions, and inferred facts remain non-canon.
- Separate confirmed contradiction, possible inconsistency, and missing information. When sources conflict, report both paths.
- Do not update character, world, timeline, glossary, profile, or manuscript files automatically.
- `talewisp_save_proposal` creates a pending proposal without altering the manuscript. `talewisp_apply_proposal` requires explicit confirmation, verifies the original hash, and creates a backup.
- If a source changed after a proposal was created, stop and regenerate the proposal from the current version.

## Response shapes

For direct writing or continuation: state the selected direction briefly, show the prose, then list only new facts that would require canon approval.

For revision: show the revised passage first, then the consequential changes.

For continuity checks: give the outcome first, confirmed contradictions with paths, possible inconsistencies or missing evidence, and the smallest safe correction.
