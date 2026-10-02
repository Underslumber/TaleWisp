# Shared style contract

Use this contract to organize style evidence when the author requests analysis,
review, or training. It does not start calibration, add a production reviewer,
or establish that an evaluator predicts author preference. Existing profiles
are not migrated automatically; propose changes for author acceptance.

## Profile and rule identity

Keep the existing `type: style-profile` and `profile_kind` values:
`author-voice`, `genre-contract`, `narrative-mode`, or `index`. Character and
scene applicability belong inside cards, not in new `profile_kind` values.
An index links the relevant profiles; it does not merge their authority.
Use [the profile template](../templates/style-profile.md) for new drafts.

Assign each card a stable ID unique within the project. Preserve the ID while
clarifying the same mechanism, record revisions, and use a new ID for a
different mechanism. Both writer and evaluator use these IDs. Card details are
Markdown documentation, not a new parser or MCP API.

Legacy confirmed observations remain usable through the existing production
route without first gaining card IDs. Systematization is not a readiness gate;
introduce cards for an author-requested draft or an accepted revision, not an
automatic migration of the active voice.

| Card field | Required content |
|---|---|
| Mechanism and intended effect | What the prose does, and what experience it is intended to create; avoid adjectives alone. |
| Applicability | Layer: author, project/genre, narrative mode, character, or scene moment. State **when** the mechanism applies, its bounds, and exclusions. |
| Strength | Rule status (`hypothesis`, `confirmed`, `conditional`, `rejected`, or `retired`), empirical confidence with evidence limits, and author acceptance recorded separately. Filled content is not approval. |
| Literal evidence | Exact source excerpt or generated-to-author-correction pair; path/link, fragment coordinates, attribution, and relevant context. Mark permission for production versus training/evaluation reservation. |
| Negative contrast | Literal near-miss/counterexample serving the same function, with provenance. If unavailable, write `unknown`; never invent author prose. |
| Positive observables | What a reader can point to in the passage to support the mechanism, without word-count or sentence-length quotas. |
| False-positive proxy | A surface feature that resembles compliance but does not establish the intended effect. |
| Exceptions | Supported variation and conditions that suspend or modify the rule; cite evidence or mark the proposed exception uncertain. |
| Writer instruction | Smallest usable instruction that preserves the mechanism without scripting every sentence. |
| Evaluator question | A question answerable from the tested surface and cited evidence, including alternative readings. |
| Unknowns | Missing context, ambiguity, conflicting sources, and what evidence would distinguish explanations. |

Universal grammar, knowledge, referents, staging, and physical causality are a
separate correctness axis. Fixing them does not earn an author-voice bonus.
Do not generalize a character voice, genre convention, or one scene preference
into an author rule.

## Two views of the same cards

For production, compile only confirmed, applicable instructions into the short
[production INPUT](production-input.md). Include card IDs and one or two
relevant, production-allowed literal examples with provenance. Resolve missing
critical context before dispatch. Keep full cards, research history, scores,
and evaluation tables outside the writer packet. The writer internally builds
the necessary structure and returns finished prose in one generation; no JSON,
ledger, gate, or hidden rewrite loop is introduced.

For an explicitly requested evaluation, provide the same applicable IDs with
their full relevant evidence, exceptions, unknowns, and the exact reading
surface. Use [style-evaluation.md](style-evaluation.md). Rule coverage is an
evidence report; it is not an automatic ranking of literary quality.

## Learning and approval

Literal author prose and author corrections outweigh AI commentary about
voice. A numerical author rating supervises preference ordering; it does not
explain the mechanism or confirm an evaluator's invented rationale. Preserve
disagreement rather than rewriting evidence to fit known scores.

Keep training evidence outside canon and durable profiles. One failed example
supports a bounded hypothesis, not a universal ban. Confirm a generalization
only after relevant cross-context evidence or held-out control and author
acceptance; document limits. Freeze old and proposed contracts before comparing
them on the same scene and on future controls. Separate training examples from
held-out evidence, record access, and prevent test leakage. Repeated rescoring
of known examples by the same evaluator does not prove improvement. No new
round or profile promotion follows automatically from this document.
