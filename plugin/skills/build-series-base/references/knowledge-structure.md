# Source-grounded hierarchy and relationships

Read when building or evaluating the nested knowledge structure of a work. This is the semantic design guide; [knowledge-runtime.md](knowledge-runtime.md) defines the separate executable compiler contract. Neither extends the existing importer analysis JSON or the legacy interface schema. Preserve those contracts. Use a separate proposal for unsupported structures; do not migrate an existing author's base from this guide alone.

## Separate four structures

| Structure | Purpose | Constraint |
|---|---|---|
| Storage ownership | Author → project/series → shared records and book-local narrative | One canonical record per established identity within its scope; shared characters and rules are not copied into every book |
| Navigation tree | A readable route from broad topics to specific concepts | One primary parent per displayed node; other routes point to the same identity |
| Semantic relationships | What entities and concepts actually do or mean relative to one another | Typed, sourced, scoped links; navigation ancestry is not proof of a world relation |
| Evidence and versions | Why a claim is recorded, when it applies and who knows it | Preserve source coordinates, contrary observations, author deltas and unresolved status |

A single novel may use a project container without inventing sequels. Shared-world cycles, parallel timelines and alternate versions need explicit scopes; a common author or matching name does not make their canons identical. A reference document is a source, not automatically a narrative book with scenes. Keep author-wide style outside world-specific mechanics.

```text
Author
  Project / series
    Sources and their editions
    Shared world, identities, rules and evidence
    Book → plot → scenes
    Views → topic trees, chronology, glossary, knowledge

Topic tree → canonical identity ← other topic views
                  |
                  +→ claims → evidence / scope / time / knowledge
                  +→ typed links → other identities
```

## Build from distinctions found in the work

1. Read the bounded sources and accepted author corrections. Extract terms, definitions and explicit relations before assigning parents. Native heading levels preserve the source outline; retain that outline as provenance rather than assuming every heading is a world entity.
2. Reconcile identities within project/world/version scope. Distinguish a concept from its instance, a collective from a person, a title from its bearer and a word from its several meanings. Identical spelling is a search hint, not a merge instruction. Keep uncertain aliases unresolved.
3. Identify the work's major domains and independent axes. Examples include physical laws, technology, biology, institutions, geography, belief and exceptional powers. Create only source-supported or clearly labeled navigation groups. An absent magic system requires no empty magic branch; unexplained phenomena need no invented mechanism.
4. For each sibling group, state the question it answers: kinds of what, parts of what, methods of doing what, stages of what, or topics about what? Use one axis per group. Separate headings when the axis changes. Do not put an energy resource, an institution and a spell effect beside one another as equivalent kinds of magic.
5. Choose a primary navigation home that explains the term without duplicating its identity. Add cross-links for other supported contexts. If the work truly supports several classifications, preserve them in separate views or semantic links rather than forcing them into one exhaustive tree.
6. Populate concepts with their full relevant sourced explanation, qualifiers and versions. A short label and a child count are navigation, not a definition. A selected display definition does not silently cancel the other versions.
7. Review paths and cross-links against sources, then check retrieval on questions the author or writer needs to answer. Record unsupported placement as provisional; never conceal it as established ontology.

There is no fixed correct depth. Add a level when it expresses a useful supported distinction; remove no author's material to shorten a route. Avoid both a flat list of unrelated facts and chains of empty singleton folders. A singleton branch can be justified when its parent has its own meaning or anticipates a source-established category. A header such as “Notes” belongs to document organization unless its contents establish a useful topic group.

## Decide between nesting and a link

For every proposed parent/child pair, complete a sentence and identify its basis:

| Sentence | Semantic relation | Navigation consequence |
|---|---|---|
| X is a kind of Y | `is_a` | Suitable for a classification branch; do not infer it from proximity |
| X is an instance of Y | `instance_of` | Keep instances distinct from subtype definitions |
| X is a component of Y | `part_of` | Suitable for a composition view; not inheritance of all properties |
| X is a topic within Y | `topic_under` | Navigation only, not a physical or taxonomic claim |
| X serves as R in construction Y | `role_in` with role R | A contextual role is not a permanent subtype of X |
| X and Y are explicitly different | `distinct_from` | Preserve the distinction; do not create an alias or infer lack of interaction |
| Description D2 replaces D1 in scope S | `supersedes` | An editorial relation between scoped assertions, not an in-world event or automatic entity merge |
| X uses / requires / produces Y | `uses` / `requires` / `produces` | Usually a directed cross-link, not parentage |
| X belongs to / is located in Y | `member_of` / `located_in` | Time-scoped association; an alternate view may group it |
| X precedes / causes Y | `precedes` / `causes` | Chronology and causality; ordering alone does not establish cause |
| X knows / believes claim C | epistemic record | Keep apart from C's objective validity |

These names are design vocabulary. The universal compiler supports explicitly declared predicates through its own contract; a legacy runtime with only `parentId` and `related` still cannot express all of them. Keep the two schemas distinct. Do not pass new fields to the existing importer or legacy interface just because this guide names them.

The relation vocabulary is open. Define each additional predicate by meaning, endpoint roles, direction or symmetry, applicable scope, cycle policy and transitivity. Derive its use from evidence, not from a need to fill a graph. For example, `created_by` is different from `is_a`; a transfer event needs a sender, recipient, transferred object, conditions and resulting states. Keep the source's distinctions between origin, competition, absorption and transfer.

A rename of the same referent may preserve identity and add a scoped alias. Reusing an old word for a different referent requires separate meanings; it is not a rename of the old entity. Supersession can relate descriptions without merging their subjects. A category label, a rank on an ordered scale and a role in a construction answer different questions. Different scales need no invented conversion. Viewpoint-specific or colloquial names may be scoped aliases when common identity is supported.

An edge proposal records endpoints, predicate, direction, claim status, applicable world/version/time, exact evidence and any conditions or exceptions. Evidence must support the relation itself, not merely mention both endpoints. Unspecified direction stays unspecified; generic `related` does not establish `causes`, `requires` or symmetry. Store an interaction involving several participants as an event or relation record with participant roles rather than losing conditions in unrelated pairs.

Never turn all cross-links into parents. Geographic containment, subtype classification and navigation must be cycle-free within their defined containment semantics. Mutual alliances, reciprocal influences and feedback can legitimately form cycles in other relation types; a blanket acyclic graph requirement would destroy information. Transitive closure is valid only when the declared predicate is transitive and all assertions have compatible world, time, version and granularity scope. Strict subtype relations can be transitive; a loosely worded component or location relation is not automatically strict transitive containment. Neither ancestry nor transitive closure alone licenses inheritance of properties, exclusivity, numerical thresholds or equivalence.

## Adapt to different worlds

Use the following as diagnostic axes, not mandatory branches or a checklist of missing lore:

| Work | Possible supported axes | Common category error |
|---|---|---|
| Learned magic | Resource, access, representation, construction method, discipline, effect, cost, limit | Making a resource or a school building a spell subtype |
| Innate or inherited power | Origin, bearer, manifestation, acquisition/transfer, development, competition | Treating all manifestations as separate powers or inventing automatic inheritance |
| Cultivation or game-like progression | Practice, stage, skill, resource, condition, transition | Equating numeric level, social rank and combat strength |
| Science fiction | Physical premise, technology, device, infrastructure, operation, constraint, failure | Treating a civilization, an engine and its energy supply as one taxonomy |
| Mixed or unexplained phenomena | Separate systems, observed interactions, uncertain explanations | Inventing one energy or a conversion rule to unify them |
| No speculative system | Society, places, professions, relationships, events, beliefs | Adding fantasy branches or making a character's belief a world law |

Several systems may be independent, overlapping, competing or understood differently by factions. A source's word “magic” can be an umbrella, one specific practice or a popular misnomer. Preserve these meanings with explicit distinctions. Different names need not mean different identities; shared words need not mean identical systems. Unknown does not mean absent, impossible, free or unlimited.

## Keep facts, versions and knowledge distinct

Stable identity survives a display rename or navigation move. Do not derive durable identity solely from title or parent path. In a legacy index that already does this, retain IDs and redirects through an explicitly authorized migration; the guide does not itself authorize regeneration.

Distinguish changes in the fictional world from changes in its description. An earlier edition, an author correction, a character's false explanation and a later event are four different cases. Apply corrections only to the named claim and scope; retain unaffected facts. Do not select current truth solely by file timestamp or first definition in an array. Preserve contradictory evidence until its resolution is grounded.

A useful conceptual fact record has subject, assertion, source/locator, basis (observation, speech, author statement or inference), epistemic status, applicable world/edition, validity interval or event boundary, and disclosure/holder where relevant. Map only supported fields into the current contract. Exact calendar dates are optional: partial event order and unresolved time are valid representations.

Card-level confidence is insufficient when its facts differ. Separate author acceptance, evidence strength, objective validity, navigation certainty and disclosure status. An author's secret can be true without being known by a character or reader. Narrative order does not establish world order; a flashback must not leak later knowledge into earlier scenes.

Record intended disclosure at the claim/definition level in `structure-proposal.md` and the compiler specification: author-only, reader-revealed at a source coordinate, and known/believed by named holders at their learning boundaries, as applicable. These are separate axes, not one linear visibility rank. The universal compiler's query projects this metadata; the legacy index is not migrated or filtered by that addition. Consumers must use the filtered query rather than raw compiled files for scene-safe retrieval. If another retrieval index cannot represent or filter disclosure, say so explicitly: access to an unfiltered private definition does not authorize using it as viewpoint knowledge or public explanation.

## Acceptance checks

Mechanical checks establish IDs, existing endpoints, resolvable aliases/redirects, no forbidden parent cycles, reachable tree paths and valid source coordinates. They do not establish semantic correctness. Check relationship cycles according to predicate, not globally.

Semantic review must answer:

- Does each meaningful parent explain its child, with a consistent sibling axis and traceable placement basis?
- Are methods, resources, effects, institutions, stages, contextual roles, classes and instances distinguished where the source distinguishes them? Are explicit nonidentity and changes in terminology preserved?
- Can one identity be found through several contexts without copying or merging unrelated entities?
- Does every factual relation have supporting evidence for its predicate, direction and scope? Are mere co-mentions excluded?
- Are full explanations, restrictions, exceptions, contrary accounts and author corrections preserved?
- Can the same guide represent multiple independent systems and a work without speculative mechanics, without inventing branches?
- Can a writer retrieve what applies at a scene and what the viewpoint character knows, without importing another edition or world?

Use small synthetic transfer cases for testing: two unrelated power systems with a shared term; a resource used by several technologies; an institution teaching a method; a component serving different roles; two different people sharing a title; explicit nonidentity; a renamed referent versus a reused term; a world-state change versus an editorial correction; and a realistic story with no magic. Evaluate actual structures and answers rather than matching headings. Reviewer-designed cases establish design feasibility; an independent agent receiving the skill and raw sources establishes bounded behavioral evidence. Distinguish these from a full import/runtime test. Passing cases does not prove correctness for every work.
