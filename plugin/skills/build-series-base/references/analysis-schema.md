# Structured analysis contract

The importer performs extraction and mechanical assembly. The model performs the full source reading and semantic analysis. Use the actual IDs and paths returned by `prepare`; do not fabricate them from this example or from a previous series.

## Prepared sources

The prepared result includes `session_id`, `series_path`, `source_path`, `corpus_index_path`, `analysis_paths`, a `books` list and the expected `independent_review_path`. The book list supplies `book_id`, original title/source author, chapter/block/image counts and `corpus_file`. Read every corpus chapter and inspect its image files. Chapters have IDs/titles and blocks with `id`, `tag`, literal `text` and `image_ids`. Each source keeps its original format, path, bytes and SHA; extracted snapshots also preserve provenance and completeness. See [source inputs](source-inputs.md). Images keep source reference/binary ID, MIME type, byte count, SHA, path, cover flag and body occurrences. Readable chapter Markdown has source coordinates/anchors for references.

Save a JSON object as the session's staged analysis, then call `finalize` with its vault-relative `analysis_path`. All required arrays below are the outcome of source reading, not promises to read later.

| Key | Entry fields |
|---|---|
| `read_chapters` | `book_id`, `chapter_id`, exact original `block_ids` in that chapter's source order, `images_read`, `images_uncertain` |
| `image_transcripts` | `image_id`, `transcript`, `status` (`read` or `uncertain`); include covers and every body image |
| `scenes` | `id`, `book_id`, `title`, contiguous source `block_ids`, `participants`, `place`, `time`, `action`, `result`, `emotional_shift`, `new_information`, `evidence` |
| `events` | `scene_id`, `cause`, `consequence`, `story_time`, `evidence`; keep narration and world-time relations separate |
| `entities` | canonical `name`, `kind`, `definition`, `facts`, `evidence`, `basis`, `status`, `scope`, `valid_from`, `valid_until` |
| `rules` | `name`, `price`, `limits`, `exceptions`, `evidence`, `status` |
| `threads` | `book_number`, `name`, `goal`, `conflict`, `stakes`, `state`, `setups`, `payoffs`, `status`, `evidence`; supported threads require literal evidence |
| `knowledge` | `fact`, `holder`, `mode`, `learned_at`, `how`, `objective_status`, `evidence`, `valid_until` |
| `style` | `observation`, `scope`, `examples`, `exceptions`, `evidence`, `status` |
| `shared_layers` | exactly the nine mechanical section keys below; each `status`, `summary`, `evidence` |

Mechanical `shared_layers` keys are `series_passport`, `world`, `rules`, `entities`, `glossary`, `style`, `chronology`, `knowledge`, `uncertainties`. These shared rendering sections complement the detailed book-specific `scenes`, `events` and `threads` arrays. They do not replace the nine conceptual reading layers in [process.md](process.md); characters and other world entities remain separately identified by `kind` in the common entity collection.

## Evidence and temporal scope

An evidence item names one actual source:

```json
{"block_id": "<actual block ID>", "quote": "<literal substring of that block>"}
```

or a separately read image:

```json
{"image_id": "<actual image ID>", "quote": "<literal substring of its supplied transcript>"}
```

`supported` means the supplied evidence supports the recorded claim; it is not automatic objective truth of a speaker's testimony. Use explicit `uncertain`, `unknown` or `contradicted` where appropriate. `basis` distinguishes narration/action, speech and analytical inference. State `unknown` when a time boundary, cost, exception, outcome or identity is not established. Retain incompatible observations with their own sources.

In `facts`, use individual objects retaining `claim`, `evidence`, `basis`, `status`, `scope`, `valid_from`, `valid_until`; preserve speech/world-status distinction where relevant. Alias decisions need explicit source support; similar spelling and role names do not establish identity. Definitions summarize the supported facts of one card rather than creating another biography. Cards and glossary stay common to the series.

For narrative sources, scene `block_ids` partition their corpus without gaps or overlaps and remain in source order. Non-narrative sources retain exact `read_chapters` coverage but do not require fictional scenes/events/threads. Record inapplicable layers explicitly without inventing facts. A scene is a meaningful continuous episode, not an arbitrary fixed text chunk. Emotional shifts may explicitly be absent; do not invent one to fill the field. Source-coordinate IDs and printed section/chapter titles are different things.

Each `read_chapters` row belongs to exactly its stated book/chapter. Do not substitute another chapter's blocks even when the whole-book count would match. Image assignments match that chapter's actual occurrences: repeat the image ID in the read/uncertain lists for repeated occurrences, including reuse across chapters. Standalone body images have source blocks too. Cover assets have a global transcript but no chapter assignment unless the image actually occurs in the body. The source image transcript is recorded once per asset in `image_transcripts`.

Canonical entity names are display data, not paths. Keep punctuation and spelling in `name`; the assembler uses safe entity IDs for card filenames and link targets. Do not rename a literary entity just to make its name a Windows filename.

Knowledge modes distinguish `knows`, `assumes`, `mistaken` and reader-only access. `holder` is the actual actor or an explicitly labeled reader; a generator's access is not actor knowledge. `learned_at` and `how` retain the literal route/time of access. `objective_status` does not collapse testimony into world truth. No exact time/world ordering means unresolved temporal scope, not an invented calendar.

Style observations include all applicable dimensions from process.md with representative literal examples, scope and exceptions. They are analytic notes, not accepted author/style profiles. Unknown/missing evidence is recorded; a high literal-match count alone does not establish comprehensive analysis.

## Review and completion

`finalize` renders the draft base and exposes its `candidate_sha256`. `check` records machine results in `machine-checks.json`; it never creates an independent PASS. The applicable fresh reviewer reads the actual candidate and original sources, then root saves the review at the returned `independent_review_path`:

```json
{
  "status": "PASS",
  "review_type": "independent",
  "candidate_sha256": "<the verified current candidate hash>",
  "coverage": "<what the reviewer actually inspected>",
  "findings": []
}
```

Also include the returned `session_id` in that review JSON. Review the actual staged files in `candidate_paths`: keys are their final canonical vault paths and values are their staged files. `candidate_manifest_path` identifies the reviewed revision. The `accept` phase installs that reviewed candidate in the series namespace.

Call `accept` with that exact vault-relative `review_path` only after the review exists. It rechecks the live files and rejects stale hashes, failed reviews, and a machine result supplied as an independent review. Do not synthesize a PASS from the tool's own check, omit the semantic review, or describe intermediate state as complete.
