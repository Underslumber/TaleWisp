# Explicit continuity contract, version 1

Use only for an author-requested audit or knowledge query. Markdown remains authoritative. This helper neither changes sources nor scans unlisted canon. Do not create a contract by guessing chronology from file names or prose. Missing metadata is an actionable incomplete result.

Call `talewisp_continuity_check` with `contract_path`, or `talewisp_knowledge_at_scene` with `contract_path`, `scene_id`, `entity_id`. Paths are relative to the active vault; absolute paths, parent traversal and resolved links outside it are rejected. No automatic generation, migration, snapshot restore or production prose gate is included.

## JSON schema

The root object has integer `version: 1` and four required arrays: `scenes`, `entities`, `facts`, `assertions`. Each record has a unique nonempty string `id` within its array, `status` (`confirmed`, `draft`, `proposal`) and `evidence`. Only confirmed records with current evidence are trusted. Draft/proposal records are excluded and make coverage incomplete. IDs are explicit references; array/file order has no meaning. Empty required arrays are allowed, but an entirely empty contract is incomplete.

`evidence` is an object with vault-relative string `path`, lowercase raw-byte SHA256 string `sha256`, and nonempty exact string `quote` present in that UTF-8 source. Hash the original bytes including BOM/newlines. Quotes attest the supplied interpretation, not its semantic correctness; human preparation/review still matters. Unknown extra keys are ignored for forward-compatible annotations; they confer no trust.

| Collection | Additional fields |
|---|---|
| scenes | finite numeric `story_order`, `narrative_order`; booleans/null are invalid |
| entities | no additional required fields |
| facts | nonempty `text`, `truth` string `true`, `false`, or `unknown` |
| assertions | `kind`, trusted `scene_id`, and the references below |

| Assertion kind | Required references | Effect/check |
|---|---|---|
| death, revival | `entity_id` | world-time life transitions |
| appearance | `entity_id` | live cast appearance after death fails until revival |
| mention | `entity_id` | mention is legal after death |
| promise_setup, promise_payoff | nonempty `promise_id` | payoff requires earlier setup in reader order |
| learn | `entity_id`, `fact_id` | character access in world order |
| reveal | `fact_id` | reader access in reader order |
| knowledge_use | `entity_id`, `fact_id` | requires earlier recorded learning |
| reader_use | `fact_id` | requires earlier recorded reveal |

Example record shapes (replace every illustrative evidence with actual source evidence):

```json
{
  "version": 1,
  "scenes": [{"id":"s1", "status":"confirmed", "story_order":10, "narrative_order":20, "evidence":{"path":"scene.md", "sha256":"<64 lowercase hex characters>", "quote":"Exact source quote"}}],
  "entities": [{"id":"hero", "status":"confirmed", "evidence":{"path":"hero.md", "sha256":"<64 lowercase hex characters>", "quote":"Exact source quote"}}],
  "facts": [{"id":"belief", "status":"confirmed", "text":"The hero believes the door is safe.", "truth":"false", "evidence":{"path":"scene.md", "sha256":"<64 lowercase hex characters>", "quote":"Exact source quote"}}],
  "assertions": [{"id":"learn1", "status":"confirmed", "kind":"learn", "scene_id":"s1", "entity_id":"hero", "fact_id":"belief", "evidence":{"path":"scene.md", "sha256":"<64 lowercase hex characters>", "quote":"Exact source quote"}}]
}
```

## Boundaries and results

Story time governs life and character knowledge. Narrative time governs promises and reader access, allowing flashbacks without confusing those axes. A prerequisite strictly before use is required; same-scene/tied coordinates cannot prove prior access and are incomplete. A live appearance tied to a life transition is incomplete. With no recorded transition before appearance, the helper makes no claim about initial life state. Missing prerequisites are incomplete; a use before every trusted later prerequisite fails. Contradictions fail even when other records remain incomplete.

Audit statuses are `FAIL`, `INCOMPLETE`, or at most `PASS_LISTED_RECORDS`. `coverage.scope` always says `listed_records_only`; collection counts report listed and trusted records, and skipped drafts/proposals are explicit. A PASS never proves unlisted canon, physical plausibility, style, a fact's objective truth, or evidence interpretation. Findings carry record addresses and source evidence when available. Source byte hashes and the contract byte hash identify the checked snapshot.

Knowledge projection uses the **start of the scene**: same-scene learn/reveal is excluded. It returns `known_to_character`, `reader_known`, and `character_only_do_not_reveal` separately. Each exposed fact includes structured text, truth annotation, and source/access references (path and byte hash, without raw quotes); a false belief can be known without becoming objective truth. Facts with no trusted prior access are omitted without their text or quotes. All evidence quotes are removed from projection to avoid exposing future/untrusted secrets. Invalid records still yield `INCOMPLETE`; consumers must not treat an incomplete projection as a complete writer-ready input. The existing raw `scene_context` is not a secrecy filter.

Learning in a different scene tied with the target's story order, or a reveal in a different scene tied with its narrative order, is unresolved: that event confers no access and the projection is `INCOMPLETE`. Learning/reveal in the target scene itself is a determinate start-of-scene exclusion and does not alone make the projection incomplete.

No learning/reveal record means unknown access, never implicit access. Knowledge is monotonic in this first contract: forgetting, deception targets, time-varying fact validity, concurrent within-scene beats, implicit initial life state and semantic extraction are outside scope. Model these only through a future explicit contract extension, not inferred facts.

## Maintenance after source edits

Use `talewisp_continuity_impact` with explicit vault-relative `contract_paths` (1..32), and optionally `changed_source_paths`, to identify current stale/missing evidence and the records and assertion references affected by an edit. An explicit changed path requests a conservative impact check even if its bytes currently match; it is not proof that the source changed. Include draft/proposal evidence: exclusion from trusted canon does not remove its dependencies. Only explicit record references and source bindings establish dependencies; prose similarity and filenames do not.

Use `talewisp_continuity_gaps` with the same explicit contracts to obtain an actionable, prioritized queue from audit findings, unconfirmed records, and declared coverage omissions. A listed-record PASS can still have coverage tasks: it never means an entire manuscript was extracted. Repair suggestions require source evidence and author approval before applying any canon change. These reports are author/editor diagnostics, not secrecy-filtered input for a writer; use `talewisp_knowledge_at_scene` for the latter.

Both tools are read-only, bounded, and deterministic for the same files and arguments. They do not scan the whole vault, update statuses, infer missing dates, or automatically refresh evidence hashes. After revising a source, reread and independently verify the affected claims before proposing replacement evidence.

Limits: 32 explicitly listed contracts, 64 explicitly changed source paths, 256 distinct files including contracts, 2 MiB per file, 64 MiB total reads, 10000 total listed records, and 100000 dependency links per contract. Oversized scope fails without truncation. Old extraction receipts containing only digests cannot reconstruct package-level source paths: the report labels that gap, while still following each record's explicit evidence links.

The helper reads at most 2 MiB per file, 5000 total records, and 32 MiB distinct evidence bytes, using no third-party dependency. Limits fail closed; no huge vault scan occurs. It implements original Python rules inspired by the distinction between story time and reader time in [Story Skills v0.22.1](https://github.com/danjdewhurst/story-skills/tree/v0.22.1); no upstream JavaScript is bundled.
