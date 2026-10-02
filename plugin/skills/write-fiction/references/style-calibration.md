# TaleWisp style calibration and writer training

Calibration improves the author-specific generation prompt. It is not a mandatory production gate and must not turn every passage into a chain of agents.

## Contract with the author

Start only after explicit agreement. Explain the practical goal:

> Мы проверяем не один текст ради самого текста, а способность писательского помощника стабильно воспроизводить ваш способ строить сцену. Несколько слепых вариантов получают одинаковое задание, после чего мы сравниваем результат с вашими образцами и выясняем, какое изменение промта действительно помогло. Обычная работа после калибровки остаётся одношаговой: помощник внутренне собирает каркас и сразу пишет готовую прозу.

Do not require the author to complete all coverage before training can begin. Start when the available corpus supports a meaningful baseline, then request another calibration only for a named evidence gap.

## Separate the layers

Classify feedback before changing the writer prompt:

1. fact, canon, or knowledge-at-time repair;
2. missing context, motivation, relationship, or stake;
3. universal logical, spatial, physical, or referential repair;
4. genre dramaturgy or reader-effect change;
5. narrative mode or focalization;
6. author rhythm, syntax, diction, imagery, or compositional focus;
7. character-local voice;
8. scene-local preference.

Only the relevant remainder becomes author-voice evidence. A logically repaired text is not automatically stylistically closer.

## Evidence sources

Use three kinds of evidence without mixing their roles:

- representative author prose establishes broad tendencies and exceptions;
- literal `generated version -> author correction` pairs reveal what the generation prompt failed to reproduce;
- held-out author samples test whether a prompt improvement generalizes.

Do not give blind candidate writers the complete author samples or expected conclusions reserved for evaluation. Compile a short candidate contract from confirmed evidence. The evaluator receives the complete relevant evidence only after all candidates have generated their passages.

Old failed machine runs are error logs, not positive literary examples. They may define known failure classes but cannot teach voice by imitation.

## Baseline readiness

Before the first competition, verify that the corpus covers at least several distinct functions rather than merely many words:

- action or physical urgency;
- exploration, description, or atmosphere;
- dialogue with motive and subtext;
- interiority or knowledge limits;
- at least one mixed transition involving perception, emotion, and decision;
- more than one emotional register.

Gaps do not block a baseline competition when the tested feature is supported. Record them and choose later calibration scenes that distinguish competing hypotheses.

## Training round

1. Select one controlled scene and at most three linked prompt hypotheses.
2. Fix facts, viewpoint, character knowledge, intention, stake, desired reader effect, event chain, prohibited additions, and stopping point.
3. Prepare two or three prompt variants. Change only the mechanism being tested; avoid unrelated stylistic differences.
4. Launch blind `style_editor` candidates in parallel. Each candidate receives the same scene contract and its assigned prompt variant.
5. Each candidate silently builds its causal/perceptual skeleton and returns finished prose in one generation. No separate generation record, pre-prose reviewer, or revision loop occurs.
6. After all candidates finish, send their literal texts, prompt variants, the controlled task, author samples, confirmed rules, and known failure classes to one independent evaluator.
7. The evaluator reconstructs what each prompt caused. It must identify evidence, not merely rank personal preference.
8. Record the winning mechanism, regressions, uncertainty, and next held-out test. Do not promote the prompt from a single convenient success.

## Evaluation dimensions

Use the same applicable rule IDs as the writer, organized by [style-contract.md](style-contract.md). Apply [style-evaluation.md](style-evaluation.md): separate correctness, literal realization of a mechanism, and holistic reader effect. A count of compliant rules is not a voice score; numeric author ratings establish preference without explaining its cause. This protocol does not validate an evaluator by itself.

Evaluate universal correctness first, then style:

- reader access, knowledge owners, referents, staging, and physical causality;
- preservation of fixed events, message, climax, and requested scope;
- motivated attention: why the detail is selected now, how it develops, and what receives focus next;
- continuous virtual camera without an inventory pan;
- dynamic distance and subjective coloring as personal significance grows;
- sentence boundaries that follow one experiential wave rather than a mechanical length pattern;
- short accents reserved for earned focus;
- dialogue roles, practical motive, observation, pause, and character interpretation;
- emotional turn as concrete result -> personal reinterpretation -> immediate impulse -> next action;
- correction burden, separated by feedback layer.

Load only the locally selected author's confirmed private profile and scene-relevant excerpts with provenance from their own vault. Never bundle or transfer private profiles or examples to another project.

## Prompt diagnosis

For every meaningful failure, state:

- the first literal place where the text stops working;
- the affected layer;
- whether the scene contract lacked information or the prompt failed to use available information;
- the smallest prompt change that would block the root defect without overconstraining other scenes;
- what different scene type can falsify that change.

Do not append synonymous rules after recurrence. Reopen the mechanism hypothesis and replace the failed instruction.

## Promotion rule

A prompt change can move from hypothesis to working rule only when:

- it improves at least two materially different scene types, or one training scene plus a held-out control;
- it does not merely repair a fact, missing context, or universal logic defect;
- it does not flatten intentional variation;
- it does not increase structural author corrections elsewhere;
- the author accepts the resulting formulation or the literal evidence is strong enough to present for confirmation.

The final writer prompt remains shorter than the accumulated research log. Compile operative rules and keep examples, failures, and historical reasoning in the training evidence rather than injecting all of them into every generation.

## Additional calibration requests

Ask for another author calibration only when it has high information value. State the missing distinction and propose one narrow scene that would resolve it. Good gap-filling controls often include:

- an active narrator who comments while remaining attached to the current image;
- a warm or humorous dialogue with practical subtext and no threat;
- a held-out mixed scene combining discovery, personal reinterpretation, dialogue, and decision.

Do not ask for more samples merely because training can always use more data.

## Optional deep diagnostics

When a root defect recurs and its cause cannot be isolated from final prose, an explicit laboratory run may use generation records, causal ledgers, cold readers, fingerprints, and `fiction_gate.py`. This diagnostic investigates the prompt mechanism; it is never the default route and does not establish authorial style by itself.

Do not launch a deep diagnostic without telling the author what exact uncertainty it should resolve.

## Calibration state

Use these states for prompt hypotheses: `hypothesis`, `recurred`, `working rule`, `conditional`, `rejected`, and `mistaken for style`.

Use these states for a round:

- `valid`: fixed content and universal foundations held;
- `partially valid`: usable style evidence remains after separating foundation repairs;
- `invalid for style`: facts, causality, motivation, staging, or the scene message had to be rebuilt.

Correction ratios are only a trend within valid or partially valid rounds. They are not a quality score.

## Final synthesis

Return:

1. prompt mechanisms supported across situations;
2. conditional rules by scene type;
3. universal findings that belong in the editor protocol;
4. invalid or partially valid rounds and why;
5. rejected and demoted hypotheses;
6. remaining coverage gaps;
7. held-out results and correction burden;
8. the smallest proposed update to the production writer prompt and durable profile layers.

Do not overwrite profiles. Show the synthesis and save it only after explicit author approval.
