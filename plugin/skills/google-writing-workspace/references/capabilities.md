# Capability boundaries

Provider documentation was checked on 2026-09-30; author native-review correction applied on 2026-10-01. Re-discover the current runtime before execution: provider capability and connector schema are separate evidence layers.

| Surface | Available route | Required evidence |
|---|---|---|
| Docs text, tabs, styles, controls | Google Drive/Docs connector and trusted read | Full relevant tab content, revision, protected elements |
| Direct edit | Connector batch update only for explicit direct-edit authorization | Exact fresh readback and preserved structure/styles |
| Native suggestion (existing manuscript default) | Docs API supports `WriteControl.writeMode: SUGGEST`; current connector `write_control` exposes only `requiredRevisionId` / `targetRevisionId` | Live schema permitting `writeMode`, saved thread status, pending suggestion readback |
| Suggestion without connector support | Browser editor in verified Suggesting mode only with separate author browser authorization | Saved pending IDs tied to exact original/replacement, accept/reject controls and pending-suggestion readback |
| Manuscript comments | Supported native range-anchored API if exposed; editor only with separate browser authorization | Exact quote, target tab/range and editor linkage through supported API/editor evidence, saved thread/readback |
| Replies | Drive comment tools for a verified existing thread | Complete paginated context, correct live thread ID and saved reply readback |
| Google Keep | No Keep connector tool in this integration; live Docs side-panel may expose Keep UI | Inspect actual UI/access; never claim a connector read or sync |
| Notes and story index | Requested Notes Doc and existing bounded Sheets ranges | Verified source bindings, draft/confirmed authority, fresh range readback |

Google's [suggestions guide](https://developers.google.com/workspace/docs/api/how-tos/suggestions) supports API suggestion creation; do not state that the API universally cannot suggest. When the connector later exposes it, request suggest mode explicitly, keep inline suggestion coordinates, and require `commentUpdateState: ALL_SAVED` plus thread readback. `ALL_FAILED_UNKNOWN_REASON` can coexist with committed document changes; missing/unknown status requires reconciliation before retry. Check supported request types: tab changes and some document/header/footer formatting cannot be suggested.

The [Drive comments guide](https://developers.google.com/workspace/drive/api/guides/manage-comments) says Workspace editors treat API-created Drive anchors as unanchored. A `quotedFileContent` value or quote in the body is not a native range anchor. Reading an opaque editor anchor is evidence that the existing thread has anchor metadata, but cannot independently prove an arbitrary user-supplied anchor targets the requested quote. Verify exact quote and editor linkage through a supported API or authorized editor; do not decode reliable coordinates by guessing. Native Docs API comment capabilities are broader, but current connector support must be discovered separately.

The [Keep API overview](https://developers.google.com/workspace/keep/api/guides) describes enterprise administrator integration. A usable Keep side-panel does not imply that this consumer session has enterprise API access. Authorized UI note work can use the verified panel; recurring connector-driven notes should use a requested Notes Doc. Do not create one or a Sheets workbook just because Keep integration is absent.

Local helper plans default to `edit_mode="native_suggestion"` and emit no direct mutation payload, including after revalidation. Only an explicit author direct-edit request permits `edit_mode="direct_edit"`. Full reads, inline UTF-16 coordinates, styles, protected controls and concurrency checks apply to both modes. If native writing or anchoring is unsupported, report that product unfinished; no automatic preview/direct/unanchored substitution. Already authorized supported connector actions need no repeated confirmation. The author sample with anchored comment and pending suggestion IDs is read evidence, not verification of our write.
