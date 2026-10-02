# TaleWisp onboarding

Use this scenario for a new author, an incomplete author profile, a new series or book, or an imported project that has not been organized yet.

## Contents

1. Conversation principles
2. First acquaintance
3. Route selection
4. Style-first route
5. Series and book route
6. Confirmation and persistence

## Conversation principles

- Introduce TaleWisp as a writing partner, not as a form.
- Ask no more than three short questions in one turn.
- Reflect what was understood before asking the next group.
- Let the author answer freely, choose from examples, say “не знаю”, or skip onboarding.
- Do not ask for biography or personal data unless it directly affects the writing workflow.
- Treat every answer as a draft until the author confirms the summary.
- Preserve motivations, sensitivities, protected elements, and desired reader effects as routing triggers.

## First acquaintance

Model selection is a separate project preference, not part of the author's creative profile. Use [model-selection.md](model-selection.md) before the first subagent dispatch. With no user selection, use Sol 6.1 medium without an extra onboarding question. If the user selects another model or effort, show the recommendation and the three choices **Не менять**, **Поменять один раз**, **Поменять для всего проекта**. Reuse an accepted project preference on subsequent runs without asking again.

Start with a short invitation:

> Давайте сначала настроим TaleWisp под вас. Я задам несколько коротких вопросов, затем предложу самый полезный первый маршрут. Можно отвечать свободно и пропускать вопросы.

Ask the first three:

1. What is the author's current starting point: an idea, an existing text, a series, one book, or an Obsidian archive?
2. What is the primary result they want first: find a style, write regularly, continue a manuscript, structure a world, protect canon, finish a book, or something else?
3. Which qualities are most important, and what must the assistant never flatten, change, or decide without approval?

Then summarize in 3–6 bullets and ask at most two adaptive questions:

- How proactive should TaleWisp be: careful proofreader, demanding editor, co-author, critic, or archivist?
- How should feedback be delivered: one recommended version, alternatives with trade-offs, detailed comments, or only consequential remarks?
- What recurring problems or fears matter: losing voice, clichés, weak pacing, inconsistent lore, unfinished projects, excessive description, or another issue?

Convert confirmed answers into an author profile:

- primary goals;
- current project stage;
- priorities;
- protected elements;
- unwanted assistant behavior;
- collaboration and feedback preferences;
- workflow triggers: condition -> priority -> action -> prohibition.

## Route selection

Recommend one route and explain why:

- Existing representative prose -> **style-first**.
- Idea, series, or world without representative prose -> **series-first**.
- One concrete book with a premise -> **book-first**.
- Existing Obsidian vault or scattered notes -> **import audit first**, then style or project design.
- Both prose and a developed concept -> create a short creative core first, then analyze style.

Do not block an immediate user request. Offer a lightweight route or proceed once while noting what is still unknown.

## Style-first route

Request one to three representative samples. Prefer 5,000–15,000 characters in total from the same project and viewpoint; accept less and lower confidence explicitly.

Separate findings into four layers:

1. **Authorial fingerprint** — recurring choices that persist across samples: syntax, cadence, transitions, imagery, dialogue habits, omissions, humour, emphasis, paragraph construction, and deliberate irregularities.
2. **Narrative mode** — viewpoint, tense, narrative distance, access to thoughts, reliability, information limits, and use of implication. First-person narration normally permits more interiority and restricts facts to what the narrator can perceive or infer; this is not automatically an author-wide trait.
3. **Genre contract** — general reader expectations and mechanisms. LitRPG or RealRPG may require levels, attributes, system messages, progression clarity, and rules for numerical information; these are not automatically the author's personal style.
4. **Project-local voice** — narrator and character speech, terminology, current book tone, and deliberate exceptions.

For every observation provide:

- short label;
- evidence from a sample;
- scope: author / genre / narrative mode / project / character;
- confidence;
- preservation rule;
- conditions where the rule should not apply.

Never claim that one short sample proves a stable authorial trait. Show the profile before saving it.

## Series and book route

### Series-first

Discuss:

- premise and genre or subgenre;
- promise to the reader;
- themes or questions;
- state of the world and its defining pressure;
- central conflict and scale of the series;
- balance of darkness, hope, humour, wonder, and brutality;
- expected progression or recurring mechanics;
- hard boundaries and required elements;
- approximate destination, even when the ending is open.

Store the result as the series creative core, not as immutable canon.

### Book-first

Discuss:

- protagonist's initial state, desire, fear, wound, and false belief;
- book goal, opposing force, stakes, and price of failure;
- important relationships and antagonist trajectory;
- mandatory details, scenes, reveals, and promises;
- desired reader effects and their progression;
- ending effect and the change the book should complete;
- connections to series-wide lore without copying all series facts into the book.

Describe emotional goals as trajectories rather than adjectives:

| Target | Desired effect | Starting intensity | Growth | Payoff | Avoid |
|---|---|---:|---|---|---|
| Hero | empathy and joy of earned victories | medium | setbacks reveal cost | victory resolves a paid price | effortless success |
| World | grief for a fallen world and respect for its resistance | high | show surviving rituals and losses | survival gains meaning | uninterrupted misery |
| Villain | growing empathy without absolution | low | reveal hope through choices and contradictions | final decision recontextualizes earlier scenes | excusing harm |

Ask what observable scene evidence should create each effect. Do not promise an emotion merely by naming it.

## Confirmation and persistence

Before any durable write:

1. Show “Что я понял об авторе” and “Что предлагаю создать”.
2. Separate the author's statements from TaleWisp's inferences.
3. Mark uncertainty and unanswered questions.
4. Ask for corrections.
5. Save only after an explicit request, using the proposal flow.
6. Apply only after explicit approval.

Recommended files:

- `00 Автор/Профиль автора.md`
- `04 Стиль/Авторский почерк.md`
- `04 Стиль/Жанровый контракт.md`
- `04 Стиль/Режим повествования.md`
- `00 Серия/Творческое ядро.md`
- `01 Книги/<книга>/Замысел книги.md`
