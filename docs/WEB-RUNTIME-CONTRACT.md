# TaleWisp web runtime contract

`web-client/runtime-contract.mjs` exports `createRuntimeContract({ projectRoot, globalInstructionsPath, hostCapabilities, userHomeDirectory })`. By default `projectRoot` resolves from the module location to the repository root. If `globalInstructionsPath` is supplied, it explicitly selects that host rules directory. Otherwise the loader uses `<userHomeDirectory>/.codex/AGENTS.md` when present and falls back to the three exact snapshots under `web-client/runtime-policy/` when it is absent. Orchestration and Gemini instructions are resolved beside the selected `AGENTS.md`. It assembles a versioned, read-only instruction/resource contract for a host runtime. This module does not wire routes, dispatch agents, read a manuscript, save a proposal, call Google, start a StoryArt task, or invoke Gemini.

```js
import { createRuntimeContract } from './runtime-contract.mjs';

const contract = await createRuntimeContract({
  projectRoot: process.cwd(),
  // Optional: inject an explicit global AGENTS.md path, or a test user home.
  globalInstructionsPath: configuredGlobalAgentsPath,
  userHomeDirectory: configuredUserHome,
  // Pass only observed host capability states: available, unavailable, not_checked.
  hostCapabilities: { googleNativeTools: 'not_checked' },
});
```

The returned `instructions` contain the selected global `AGENTS.md`, repository `AGENTS.md`, metadata for the four packaged skill entries, and `ROOT_WORKFLOW_INSTRUCTIONS`. The structured `skills` array carries each entry's `name`, `description`, and exact resource ID. User-specific absolute roots are replaced with portable tokens in returned text. `resources` expose exact allowlisted IDs, titles, transformed-content hashes, exact source hashes, relative source origins, a `provenance` (`local_host`, `portable_snapshot`, `project`, or `installed_plugin`), and a `derived` flag. `sourceManifest` repeats the exact source hash, relative origin, and provenance for each resource. `readResource(id)` returns the complete resource text synchronously after creation and throws for unknown IDs. Resource text larger than 128 KiB fails explicitly; it is never truncated.

The loader follows local Markdown links from these four skill entries: TaleWisp writing, series-base import, Google author workspace, and the StoryArt coordinator. It also adds the complete editor protocol, global `AGENTS.md`, orchestration policy, Gemini handoff skill, and the installed Google connector skills plus their linked instruction closure when present. The protocol comes from the project's exact `vault/99_Служебное/Редакторский протокол.md` when available; otherwise the bundled `runtime-policy/editor-protocol.md` snapshot supplies the complete text. Only user-specific absolute paths are redacted. Author prose, manuscript text, canon, character records, persistent style profiles, and series lexical dictionaries are outside the packaged resource set and must be fetched from an explicitly selected scope through the host.

Source traversal is limited to the repository `AGENTS.md`, the four declared canonical `plugin/skills` directories (with the previous fixture aliases as fallback), the exact editor-protocol path or bundled protocol snapshot, the three named global operational files, and the named installed Google connector skill root. The optional Google skill lookup uses the selected local host `.codex` root; in portable-snapshot mode, an absent Google package reports a concrete unavailable reason. Markdown links that escape those roots, symlinks, missing linked files, and oversized resources fail contract creation with an error. No directory traversal targets the vault or `web-client/.data`. Resource origins are relative identifiers; absolute private roots are not returned.

`version` is a SHA-256 digest over the instruction text, role/scenario contract, and every resource ID plus delivered/source hash. Editing a linked source changes the contract version. `sourceManifest` exposes IDs and exact source hashes for audit. The editor-protocol resource preserves the complete source text after path redaction and has `derived: false`.

`roles` records the applicable route and model pair. Ordinary agent routes use Luna high with no full-history inheritance; fiction agents are read-only. Ordinary prose uses one `style_editor` generation, with at most one conditional `continuity_reviewer`. Roleplay and calibration are opt-in. `sol_review` is disabled by default and limited to substantial code changes after machine checks; escalation also requires its explicit gate. `scenarios` use exact resource IDs from `resources` and describe continuation, revision, research, knowledge audit, onboarding, roleplay, calibration, series-base import, Google workspace, StoryArt, and code review.

Integration dependencies report `not_checked` unless the host passes observed status through `hostCapabilities`. Presence of a Google skill package reports instruction availability only; it does not imply connected Drive/Docs/Sheets operations. Google writes still require a connected native tool, live schema, authorization, and requested scope. StoryArt requires host task transport. Gemini requires its configured handoff tool and applicable policy. The module provides no runtime-success signal for any external integration.

## Focused checks

Run the contract tests with:

```powershell
node --test web-client/tests-agent/runtime-contract.test.mjs
```

The tests cover linked-source equality, exact resource IDs, path denial, missing-reference failure, source-driven version changes, scenario gates, capability-state injection, and refusal to return out-of-allowlist resources.

## Web runtime integration

The application binds this contract in `agent.mjs`. The agent must load referenced operational resources through `talewisp_runtime_resource`; selected manuscript/canon material is supplied separately. Contract, workspace and parent-turn identity are checked before child dispatch and tool results. A changed source invalidates the old binding rather than silently continuing with stale rules.

`delegation.mjs` creates fresh subscribed app-server child threads with explicit role/model/effort and bounded INPUT. Child receipts record actual thread/turn identity, lifecycle and result. Native built-in agents and broad MCP access remain disabled for these children. Normal children receive operational resources only; an import reviewer may receive a host-pinned, read-only import inventory. This is tool access control, not an operating-system sandbox.

Production uses one writer; a reviewer is conditional. Calibration and roleplay require an explicit request. Roleplay keeps leader knowledge separate from hero knowledge and sends only an accepted native skeleton to the formatter. Native mutations and Google changes become reviewable proposals; the model does not apply its own queued changes. A busy agent cannot apply proposals concurrently.

Google uses the saved site and agent authorization namespaces. Supported products include document reading, pending native suggestions, anchored comments, explicitly requested direct edits and insertions, new draft notes, and comment replies when their additional Google permission is granted. Existing authorization is reused; missing permission is reported, not replaced with credentials or a paid API fallback. Linked Sheets operations use bounded ranges and preserve formulas.

StoryArt capability now probes the official bundled Codex App MCP transport inherited from the actual desktop caller. Its narrowed allowlist permits only project discovery and dedicated StoryArt chat create/send/read/wait; the service enforces owned IDs and selected-workspace scope, journals uncertain creates without retry, and serves only reported candidate files validated inside generation output directories. This route requires Codex Desktop; a plain remote server without that inherited connection reports unavailable. No pipe identities or credentials are persisted.

Code review is an explicit selected workflow using native `review/start` on a fresh Sol 6.1 medium thread after the host constructs an actual diff from complete supplied before/after JS/MJS/JSON snapshots, runs syntax checks and records a bounded SOL_GATE. It does not claim repository reads or project-test coverage. Model, effort, sandbox and MCP inventory are checked; no ordinary child route is changed and no automatic repair follows review. Installed skills alone remain insufficient evidence of either integration; live acceptance is recorded separately. A formatter's supplied voice sample also does not prove automatic activation of a persistent author profile.

Practical acceptance evidence is recorded in `.agent/parity-completion-audit.md`. Unit checks, live subscribed model calls, Google readback and browser inspection establish different parts of acceptance; none by itself proves complete equivalence to the desktop host.
