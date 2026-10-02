# Process after the author's answer

## Scope and structure

Use the prepared session and corpus returned by the tool, not an ad hoc script for one named author or series. The new namespace is `00 Автор/<pseudonym>/<series>/`. The author hub owns links to series; each series is a separate project. Only book navigation, plot and scenes are book-local. Sources and passports are shared records with explicit book identity, rather than duplicated folders under every book.

```text
00 Автор/
└── <pseudonym>/
    ├── Автор.md
    └── <series>/
        ├── <series>.md
        ├── 00 Источники/
        ├── 01 Книги/
        │   ├── <book 1>/   (book note, plot, scenes)
        │   └── <book 2>/   (book note, plot, scenes)
        ├── 03 Сущности/
        ├── 04 Анализ/
        ├── 05 Индексы/
        └── 99 Проверка/
```

For an existing conflicting namespace follow `needs_resolution`; do not erase it or invent a new author/series to avoid the conflict. Identical prepared input can resume its session. Do not reset the baseline or counters on retry.

## Nine layers

| Layer | Required analysis | Scope |
|---|---|---|
| 1 | Book/edition passports: original titles, source author, sequence, genres, document date/version, SHA, missing metadata | Shared, identified by book |
| 2 | World rules, mechanisms, costs, limits, exceptions, culture/geography/society | Shared |
| 3 | Each book's event chain, causes/results, conflicts, goals/stakes, threads, setups/payoffs, meaningful scenes | Per book |
| 4 | Character definitions, aliases, appearance, motivations, speech/behavior, abilities, relationships and changing states | One shared card per identity |
| 5 | Items, locations, organizations, phenomena, technologies and categories; properties and timed states | One shared card per identity |
| 6 | Style: POV, tense/distance, rhythm/syntax/lexicon, dialogue, description and emotional involvement, representative examples and exceptions | Shared analysis, no profile promotion |
| 7 | Semantic scenes, boundaries, participants, place/time, action/result, emotional shift and reader revelations | Per book, plot layer |
| 8 | World chronology separate from narration order; partial ordering, retrospections, dated states and unresolved timing | Shared |
| 9 | World truth separate from actor knowledge, guesses/errors and reader access; time and route of learning | Shared |

## Source reading and reconciliation

Read all corpus chapters in bounded sequential packets. Preserve the literal original text; title/order from FB2 are not grounds to invent events or reading coverage. Read every embedded image, including statistical windows, separately from XML text; retain uncertain transcriptions rather than silently dropping them. Cover pictures do not establish narrative facts.

Delegation follows applicable project policy. For a substantial full-book import, root owns the vault and final integration; readers receive independent source ranges and write only their evidence packets. No nested agents or parallel shared-vault writes. Do not pass the complete accumulated vault to each reader. Carry accepted corrections forward and bound repair attempts.

Reconcile exact names, spelling variants, pseudonyms, people versus categories and contextual titles across all books. A similar string is not identity. One shared glossary points to one canonical card per entity; each card links back and retains sourced temporal facts. Do not merge other authors/series on common names. Preserve conflicting testimony and unresolved aliases.

Every assertion keeps a source edition, source ID and literal quote or visual evidence. Separate narration/action, spoken testimony and analysis. A quotation being literal does not prove it supports the assertion. A speaker's statement is not automatically a world law. No source means `unknown` or an explicitly marked interpretation, not invented certainty.

## Assembly and acceptance

Use the returned analysis schema and staging path. The deterministic `finalize` phase renders shared notes/cards and each book's scenes/plot, preserving sources. Its machine index may reference both books; it is not a shared plot note. Machine gates cover original bytes, coordinates, scene coverage, literal evidence, paths and links. Independent semantic review must check evidence meaning, omissions, causal chains, identities, actor/reader/time boundaries and the intended hierarchy against the actual sources and candidate.

Review is read-only and concerns the actual candidate; review the final hash again after material repair. Save a review JSON under the session with `status: PASS` and the tool's current `candidate_sha256` only after that review is actually performed. Do not supply a self-issued PASS to bypass it. `accept` verifies the matching candidate before completion. Be candid if a required reviewer or source cannot be accessed.

Preserve the configured author/style profile selection. Imported source chapters, analytic scene/style notes and author navigation are not new production samples or confirmed author profiles. Do not calibrate, rewrite prose, infer external publication dates, or import another cycle's canon automatically.
