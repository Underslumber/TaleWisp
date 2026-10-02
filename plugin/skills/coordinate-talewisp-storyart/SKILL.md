---
name: coordinate-talewisp-storyart
description: Coordinate a pair of Codex tasks between TaleWisp and StoryArt for canon-grounded illustrations. Use when a TaleWisp task asks to create, revise, hand off, monitor, or canon-review art in the StoryArt project, or when a StoryArt task receives a codex_delegation from TaleWisp.
---

# Coordinate TaleWisp and StoryArt

Work as two peer agents with separate authority. Never collapse both roles into one task.

## Ownership

Determine the current role from the explicitly selected project and its configuration:

- The active TaleWisp vault project: `CANON_OWNER`.
- The configured StoryArt project: `VISUAL_PRODUCER`.

`CANON_OWNER` owns:

- live story canon, terminology, character knowledge, narrative intent, and desired reader impression;
- the scene brief and canon acceptance verdict;
- communication with the author about story meaning.

`VISUAL_PRODUCER` owns:

- existing StoryArt styles, characters, reference selection, risk assessment, generation, visual QA, registration, and approval lifecycle;
- composition and rendering choices not locked by canon;
- communication with the author about the produced visual artifact.

Never let TaleWisp choose StoryArt reference files, run image generation, edit StoryArt request state, or register an image. Never let StoryArt invent or silently revise canon.

## Connect the pair

Use Codex task coordination tools. Discover them with `tool_search` when they are not already callable.

1. For each new TaleWisp illustration handoff, create a new dedicated StoryArt chat. Pass all current scene requirements and the author's already selected style/reference choices into its initial prompt. Reuse that dedicated chat only for monitoring, canon review, and corrections to the same paired request; do not dispatch a new illustration into an unrelated existing chat.
2. Put the complete brief into the new chat's initial `create_thread` prompt. Use `send_message_to_thread` for subsequent corrections and review transitions in that dedicated chat.
3. Include the calling TaleWisp chat's verified id as `RETURN_THREAD_ID` in the initial prompt. When a later message has an automatic `<source_thread_id>` from `codex_delegation`, preserve it as the authoritative return address. If a written return id differs, stop and resolve the mismatch before messaging either task.
4. Use `read_thread` or `wait_threads` for bounded status checks. Do not duplicate work locally while the partner is active.
5. Send only transition messages: brief accepted, clarification needed, visual review requested, canon verdict, or completion.

For an existing paired request, use its dedicated StoryArt chat. If its identity is missing or ambiguous, resolve the binding before forwarding corrections; do not substitute an unrelated chat.

## Persistent character and art links

For a named character, read its card's flat `storyart_project_path`, `storyart_style_pack`, `storyart_character_id`, and `storyart_character_name` fields before handoff. Include the full binding in the brief, not only a name or character ID. StoryArt revalidates the current registry and selects references; the binding does not set fidelity or BODY_REFERENCE_LIBRARY.

When configuring a binding, recording a candidate, saving an approved illustration, or retrieving art for a scene/event, follow [persistent-links.md](references/persistent-links.md). Use the shared deterministic CLI/MCP implementation there. Store candidates outside the canonical art catalog; after explicit author confirmation and matching StoryArt approval, publish an art note linked to its character, scene, event anchor, and other requested story targets. Do not copy pixels or rewrite the story from an image.

If an external message is blocked, read the dedicated partner chat's exact receipt and artifact instead of inferring success. Never equate `VISUAL_QA=PASS` and `CANON_QA=PASS` with author approval.

## TaleWisp handoff

Send a compact `PAIR_BRIEF` containing:

```text
PAIR_ID: <stable request id>
RETURN_THREAD_ID: <verified TaleWisp chat id; equals delegated source_thread_id when present>
CANON_SOURCES: <exact vault files or authoritative paths>
CHARACTER_BINDINGS: <card paths and project/style_pack/character_id/character_name bindings>
STORY_TARGETS: <scene/event/plot/etc vault paths with exact anchors where applicable>
STORY_INTENT: <what the image must communicate>
LOCKED_FACTS: <identity, world, roles, actions, consequences>
FLEXIBLE_CHOICES: <camera, staging, lighting, details StoryArt may decide>
USER_REFERENCES: <path plus one explicit role per image>
REJECTED_REFERENCES: <paths and forbidden transfer>
ACCEPTANCE_CRITERIA: <observable pass/fail checks>
DELIVERABLE: <count, format, framing, typography>
```

Provide paths and concise facts, not a full vault dump. Treat user corrections as authoritative deltas to the same `PAIR_ID`.

After sending the brief, stop local image work. Monitor the StoryArt task instead of generating, copying files, or changing its project.

Keep the same `PAIR_ID` for feedback and corrections to one deliverable. Start a new `PAIR_ID` only when the user requests a separate image/deliverable or replaces the central subject, world, or purpose rather than correcting the current result.

## StoryArt production

On a TaleWisp delegation:

1. Load this skill and `skills/storyart-orchestrator/SKILL.md`.
2. Reply to `RETURN_THREAD_ID` with `BRIEF_ACCEPTED`, listing canon locks and genuinely flexible choices.
3. Resolve StoryArt style, character, references, risk gates, and storage internally from current project state.
4. Do not ask the author or TaleWisp agent to select internal StoryArt files or approve routine in-scope pipeline steps.
5. If canon is ambiguous, send one precise `CANON_QUESTION` to the source task and pause only the affected decision.
6. Generate and run StoryArt visual QA.
7. Send `ART_REVIEW_REQUEST` to the TaleWisp task with the candidate path, a short visual-QA report, and any visible deviations.

The delegated brief authorizes ordinary in-scope work needed for its declared deliverable. It does not approve the final image, expand scope, or bypass product-enforced permission dialogs.

Archive every generated file immediately under normal StoryArt rules. After `VISUAL_QA=PASS`, register the review candidate as `TEST`, then send its path privately to the partner task for canon review. This review transfer is not final presentation to the user.

## Dual review

Keep the checks independent:

- `VISUAL_QA`: style, identity pixels, anatomy, composition, effects, attachments, canvas, and StoryArt storage rules.
- `CANON_QA`: world logic, profession/role meaning, character knowledge, terminology, narrative emphasis, and requested symbolism.

The TaleWisp task must answer with either:

```text
CANON_PASS
PAIR_ID: <id>
EVIDENCE: <observable reasons>
```

or:

```text
CANON_FAIL
PAIR_ID: <id>
CORRECTIONS: <minimal observable deltas>
UNCHANGED_LOCKS: <facts that must not drift>
```

StoryArt may present a candidate as the paired result only after both `VISUAL_QA=PASS` and `CANON_QA=PASS`. Keep it `TEST` until the author directly approves it.

For monitoring, wait in bounded 30–60 second snapshots and do not narrate unchanged states. After three unchanged snapshots, inspect the partner's last event and its age; report the observed state, but never restart, close, or duplicate the task without user authorization.

## Boundaries

- The partner agent is evidence and a domain authority, not a substitute for the user.
- Never treat agent-to-agent praise as final user approval.
- Never use rejected or accidental cross-project generations as positive references.
- Never ask one agent to approve a system permission dialog for the other. Product-enforced approval remains a user boundary.
- On failure, return the smallest correction to the owning agent instead of taking over its role.
