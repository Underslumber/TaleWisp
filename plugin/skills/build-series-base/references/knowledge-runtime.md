# Knowledge structure compiler and retrieval

The repository engine is `plugin/scripts/knowledge_structure.py`; an installed copy exposes the same engine under its installed `scripts` directory. It validates a caller-authored, source-grounded structure. It does not infer meanings from prose, decide whether two terms share an identity, select a current definition, or write into a vault. A host may use language analysis to prepare the spec, but the spec must state the resulting identities, views, predicates, scopes, disclosures and evidence explicitly. Compilation returns a new candidate index; the caller owns persistence and acceptance.

The public API is `compile_structure(spec: dict, source_root: Path) -> dict`, `query_structure(index: dict, query: str, context: dict | None = None, limit: int = 10) -> dict`, and `KnowledgeStructureError`, a `ValueError` subclass. The JSON schema identifier is `talewisp-knowledge-structure-v1`.

The installed wrapper accepts JSON requests on stdin through `python <installed-plugin>/scripts/knowledge_structure_cli.py --project-root <project>`. `build` and `check` accept exactly one of inline `spec` or project-relative `spec_path`, plus optional project-relative `source_root` (default `.`). `check` validates and returns counts/hash without writing. `build` writes/reuses only a candidate under `.talewisp/knowledge-candidates/`; a different existing file is never overwritten. Optional `output_path` must be under that candidate directory. `query` accepts project-relative `index_path`, `query`, optional context and limit and returns only the filtered projection. These wrapper paths are rooted in the startup project, never implicitly in a vault. The engine itself performs no writes.

Literal quote matching proves that a quote exists in the bounded snapshot; it does not prove that the quote semantically entails the declared definition or predicate. That requires source-grounded semantic review.

## Input contract

The following is a **non-runnable schema fragment**: the hash is a placeholder and some referenced nodes/sources are not declared here. It illustrates field placement only; use `fixture(root)` in `tests/publication/test_knowledge_structure.py` for a complete executable example.

```json
{
  "schema": "talewisp-knowledge-structure-v1",
  "sources": [{"id":"src-a", "path":"snapshots/world.txt", "sha256":"<64 hex chars>"}],
  "nodes": [{
    "id":"resource:cell", "title":"Cell", "type":"resource", "role":"power source",
    "aliases":[{"text":"cell core", "disclosure":{"reader":"public", "holders":[], "author":true}}],
    "label_disclosure":{"reader":"public", "holders":[], "author":true}, "public_navigation":false,
    "definitions":[{
      "id":"def-cell-v1", "text":"Engine uses cell energy.",
      "basis":"author statement", "status":"accepted",
      "world_scope":["world-a"], "version_scope":["edition-1"],
      "validity":{"timeline":"world-a-time", "from":2, "to":null},
      "disclosure":{
        "reader":{"timeline":"world-a-time", "at":4},
        "holders":[{"id":"pilot", "mode":"known", "timeline":"world-a-time", "at":3}],
        "author":true
      },
      "evidence":[{"source_id":"src-a", "quote":"Engine uses cell energy.", "locator":"p. 3"}]
    }]
  }],
  "views": [{"id":"technology", "title":"Technology", "placements":[
    {"node_id":"resource:cell", "parent_id":null, "axis":"energy resources", "basis":"The source classifies it as a resource."}
  ]}],
  "predicates": [{"name":"powers", "meaning":"supplies operating energy to", "source_role":"source", "target_role":"device", "direction":"directed", "cycles":"allow", "transitive":false}],
  "relations": [{"id":"rel-engine-cell", "source":"device:engine", "target":"resource:cell", "predicate":"uses", "direction":"directed", "status":"disputed", "conditions":"only while enabled", "exceptions":["fails without a charged cell"], "world_scope":["world-a"], "version_scope":null, "validity":null, "disclosure":{"reader":"public", "holders":[], "author":true}, "evidence":[{"source_id":"src-a", "quote":"Engine uses cell energy."}]}],
  "events": [{"id":"event-transfer-1", "title":"Transfer", "participants":[
    {"node_id":"person:sender", "role":"sender"}, {"node_id":"person:recipient", "role":"recipient"}, {"node_id":"power:seed", "role":"transferred object"}
  ], "world_scope":null, "version_scope":null, "validity":null,
  "disclosure":{"reader":"hidden", "holders":[], "author":true}, "conditions":"only while the holder consents", "exceptions":["never during contest"], "result":"The recipient holds the seed.",
  "evidence":[{"source_id":"src-a", "quote":"The seed moved from one bearer to another."}]}],
  "redirects":{"old-resource-id":"resource:cell"}
}
```

All IDs are caller-supplied durable identifiers, not generated from names or parent paths. Repeated titles and aliases are permitted and do not merge nodes. `type` and contextual `role` are separate strings. `aliases` are local to a node; reusing a word for another meaning creates another node. Each alias has its own `disclosure`; legacy string aliases are accepted as author-only. Node metadata (`id`, `title`, `type`, `role`) has a separate `label_disclosure`, which defaults to author-only. Public definitions do not automatically expose labels or aliases. The explicit `public_navigation: true` flag exposes only the title and node ID as a navigation result.

Every fixed object record rejects fields outside its declared contract instead of silently dropping them. This applies to the top-level spec, sources, evidence, validity intervals, disclosure and reader coordinates, holder grants, nodes, definitions, alias objects, views, placements, predicates, relations, events and event participants. Definition objects accept only `id`, `text`, `basis`, `status`, `world_scope`, `version_scope`, `validity`, `disclosure` and `evidence`; definition-level `conditions` and `exceptions` are unsupported. `redirects` is the exception: it is an open mapping from retired IDs to replacement IDs.

`sources.path` is a POSIX-style relative path below `source_root`; the file must exist, decode as UTF-8, be no larger than 32 MiB, and match the supplied SHA-256. Resolved symlink/junction targets must remain below the resolved source root. Every definition, relation and event requires at least one exact, non-empty quote found in the named snapshot. A locator is optional descriptive provenance. Source files are read only. Evidence is retained in the compiled candidate but evidence quotes are never copied into query results.

`world_scope` and `version_scope` are either `null` (unrestricted) or non-empty arrays of allowed IDs. A `validity` interval is null or `{timeline, from, to}`, where at least one inclusive integer bound is present. Booleans and strings are not coordinates. The caller supplies ordinal coordinates and their event order; the compiler never derives chronology from narrative order, timestamps, or lexical comparison. A query with no matching explicit timeline and coordinate cannot reveal time-gated content.

Definitions keep their own status, basis, world/version scope, validity, disclosure and evidence. All conflicting and unresolved definitions remain present; there is no first-array/current-definition winner. `status` and `basis` are explanatory open strings, not automated truth resolution.

Each view allows at most one primary placement per node, and every parent must be placed in that same view. Its `axis` and `basis` explain the classification. The compiler checks parent cycles independently within each view. Any number of views may point to the same identity.

Predicates are open declarations with a meaning, endpoint roles, direction (`directed`, `symmetric`, or `unspecified`), cycle policy (`allow`/`forbid`) and explicit transitivity. Relations must use the declared direction and include their own evidence, scope, validity and disclosure. Optional `status` must be a non-empty string. Optional `conditions` and `exceptions` preserve either a non-empty string or an ordered, non-empty list of non-empty strings. Unknown relation fields are rejected so added qualifiers cannot disappear silently. Only declared `forbid` directed predicates are cycle-checked. The compiler detects cycles only when all edge scopes overlap: world/version allow-lists are intersected, and validity intervals must share an inclusive coordinate on the same timeline. Disjoint scopes are allowed. A bounded cycle-search budget fails closed for exceptionally large relation graphs. The compiler does not infer reverse edges or transitive closure. Events preserve n-ary participants and their roles, plus optional `conditions`, `exceptions`, `result`, and `status`; condition/exception fields follow the same string/list contract, result/status are non-empty strings, and unknown event fields are rejected. Events also require their own evidence and disclosure. Relations/events default to author-only disclosure when omitted.

Redirect keys are retired IDs and redirect chains must terminate at a current node without cycles. Node IDs, definition IDs, view IDs, relation IDs, event IDs and predicate names are unique in their respective namespaces. Endpoints are validated before any traversal.

## Retrieval contract

Context is `{audience:'reader'|'author'|'holder', holder?:ID, world?:ID, version?:ID, time?:{timeline:ID,at:integer}}`. Omitted context means a safe reader context. `audience:'author'` is the only way to request author access, and only definitions with `disclosure.author:true` are returned. A holder must be named and meet that definition's explicit learning coordinate. Reader disclosure is `public`, `hidden`, or a reveal coordinate. World/version scopes, validity and disclosure must all pass. No one audience is inferred from another.

Search is applied only to definitions visible to that context. A result contains only matching accessible definitions, unless a query matches a disclosed node title/alias, in which case it may also contain that node's accessible definitions. A hidden label yields anonymous definition text with no node or definition ID. Node metadata and each alias require their own disclosure gates. A public-navigation-only result contains only the explicitly public title, node ID and marker. Aliases are never emitted. Relations/events are included only when their own disclosure passes and every endpoint/participant has an accessible label or is public navigation; their evidence quotes are omitted. Relation status/conditions/exceptions and event participants/conditions/exceptions/result/status remain available after filtering. For a holder audience, each returned definition, relation and event includes only that holder's `access_mode` (`known` or `believed`); holder IDs and grants for other characters are not projected. Hidden names, definitions, quotes, and IDs cannot create a search hit. Results are deterministically sorted and limited to 1–100.

This is an engine contract, not a claim that every TaleWisp consumer currently uses the new index. Existing importer, legacy index, WebUI and installed plugin-cache schemas are not changed by this module. The host integration must write only a new candidate path and must route retrieval through this filter before exposing results to a reader or viewpoint holder.
