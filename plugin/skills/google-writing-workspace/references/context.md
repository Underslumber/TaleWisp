# Small linked context

Compile only records relevant to the requested scene. Read linked sources rather than inferring canon from index labels. Sheets is an index and temporal context source, not a replacement manuscript.

```ini
[request]
operation = preview | direct_edit | native_suggestion | comment
author_delta = exact request
selected_voice = confirmed voice only

[source]
document_id = observed ID
url = observed source URL
tab_id = observed tab
revision_id = fresh revision
quote = literal original
comments = all pages and replies read

[scene]
fixed_events = chronological protected beats
viewpoint = character and reader access
state_at_time = source-bound states
knowledge_at_time = owner, learned fact, source, event/time
preserve = message, emotional trajectory, payoff, voice
forbid = author exclusions
```

For requested notes, prefer an existing Notes Doc. A new basic Notes Doc is created only within an author request and the Docs creation route. Each note carries a title, plot/event/character binding, source URL, tab or range, exact supporting quote, source revision, and `canon_status: draft`. An author explicitly confirming a fact permits `confirmed`; a generated suggestion never does.

For an existing Sheets index, read metadata and exact headers first, then bounded ranges (for example, the observed `События!A2:M30`, never an assumed sheet name or whole grid). Use one shared row schema:

| Fields | Meaning |
|---|---|
| record_id, kind | Stable ID; plot, timeline, character_state, knowledge, or note |
| book_id, characters, events, states | Scene scope and comma-separated exact entity/state names for helper filters |
| story_time, state_or_fact, knowledge_holder | Temporal state and who knows a fact |
| source_url, source_tab_or_range, source_revision | Recoverable evidence |
| document_id, tab_id, quote | Manuscript binding and literal source quote consumed by the helper |
| canon_status, confirmed_by | draft/confirmed and explicit author authority |

Filter by character/event/state and include earlier knowledge acquisition when it affects the current scene. Report contradictory rows and stale revisions with their sources. Do not update status, formulas, validation, or canon automatically. A new workbook requires an author request and the Sheets skill's native-copy/import route.
