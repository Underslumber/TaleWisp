# TaleWisp Web

A self-hosted writing workspace built with Node.js 24 built-ins. Drafts, notes, history, chat messages and actual delegation receipts live in app-owned storage. The selected TaleWisp series is read through scoped tools; changes to existing author material are concrete proposals for review. The Codex bridge uses the local app-server and ChatGPT sign-in; it has no OpenAI API-key fallback.

## Start on Windows

Install Node.js 24 or newer and a supported Codex CLI on the same machine. The launcher also checks Codex's bundled Node runtime. Run `start.ps1`, then open `http://127.0.0.1:8787`. The first local browser session is created by the loopback-only sign-in flow. The first agent connection asks Codex to sign in through ChatGPT. Its profile is separate from the user's regular Codex profile; no global Codex credentials, MCP servers, skills, or settings are copied into it. If Codex is not on `PATH`, set `CODEX_BIN` to the installed executable before launch.

## Start on Linux

Install Node.js 24 or newer and Codex CLI, then run `./start.sh`. Use the same browser address when the server is on the local machine. Set `CODEX_BIN` if the executable is not on `PATH`.

## Data and options

The default app data directory is `web-client/.data/`. Set `TALEWISP_WEB_DATA` to move the SQLite database and isolated Codex profile. Set `TALEWISP_CATALOG_VAULT` to choose the author/series catalog, or `TALEWISP_VAULT` for the initial vault; the default is the repository's `vault/` directory. The catalog and source metadata are inspected to resolve the selected workspace. Knowledge searches and source reads are bounded and scoped to that selection.

The local server listens on `127.0.0.1:8787` by default. `HOST` and `PORT` can be set for a private server deployment. A non-loopback host or public `TALEWISP_WEB_ORIGIN` requires either `TALEWISP_WEB_TOKEN` or `TALEWISP_AUTH_FILE`, plus an HTTPS reverse proxy. Password mode accepts a protected JSON credential file with `username`, `salt`, and `hash` fields; create the scrypt credential record with `createPasswordRecord(username, password)` exported by `auth.mjs`. Keep the plaintext password only in the operator's secret-delivery channel, never in app data. Password mode disables the shared token and local-network login. The server accepts only its bound host/port and the explicitly configured origin host; it ignores forwarded-host headers. Never expose the Node port directly to the public internet. `TALEWISP_WEB_TOKEN` is a site access token, not an OpenAI API key.

Password sessions are stored in `TALEWISP_WEB_DATA/auth-sessions.sqlite` as hashes of random device tokens. The default remember checkbox issues a revocable 90-day session; an unchecked box issues a 12-hour session cookie without persistent browser lifetime. Devices have independent sessions, and “Выйти на этом устройстве” revokes only the current browser's token. For HTTPS behind a reverse proxy, the pinned HTTPS `TALEWISP_WEB_ORIGIN` controls the `Secure` cookie attribute; forwarded headers do not establish trust.

Google Docs integration offers a local setup form; see [Google OAuth setup](GOOGLE-OAUTH.md). You can alternatively set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` before launch. Register the exact redirect URI in the OAuth client; for the local default it is `http://127.0.0.1:8787/api/google/callback`. The backend tests use a mocked Google service and do not verify live OAuth consent, token exchange, or native Docs suggestion/comment behavior; those require a separate signed-in runtime test.

To test the backend, run `node --test` from this directory. The tests use temporary SQLite data, fixture vault files, and a mock agent. Real ChatGPT sign-in and account model/limit availability require a separate runtime smoke test.

## Agent boundary

The agent process runs with its own `CODEX_HOME` in app data and a sanitized environment. It starts in an app-owned work directory with a read-only sandbox. The installed protocol does not enforce a fine-grained filesystem read allowlist. The client keeps shell, apps, and native recursive agents disabled; scoped TaleWisp tools and app-owned dynamic tools provide the allowed operations. Root tools can stage changes but cannot approve them. This narrows tool access; it is not an operating-system filesystem isolation guarantee.

The MCP server defaults to tracked `plugin/scripts/talewisp_mcp.py` and requires Python 3; set `TALEWISP_MCP_PATH` for another installed copy and `TALEWISP_PYTHON` for its interpreter (`python` on Windows, `python3` on Linux). Startup fails if a required runtime dependency is missing.

## Rules, skills and separate roles

`runtime-contract.mjs` loads complete applicable user/project instructions, the complete editor protocol, four TaleWisp skills and their operational references. Each resource has an exact ID and source/content hash. The agent reads these through an allowlisted resource tool; native skill registration and its observed result are reported separately. Portable policy snapshots in `runtime-policy/` support a server without the owner's local Codex instruction tree. Manuscripts and private author profiles are not packaged as operational rules. Relevant voice and canon sources are fetched from the selected scope.

App-owned delegation creates fresh threads on the same subscribed app-server. Writers, researchers and reviewers receive bounded explicit packets. Child MCP tools, Google actions, recursive delegation, shell, apps and network are disabled; the child MCP inventory and returned model/effort are checked before its turn. Ordinary roles use the current authorized Luna/high route after the authoritative TaleWisp model resolver confirms it. No unavailable model is substituted. A normal prose request has one writer generation; a reviewer is conditional and cannot initiate a hidden rewrite. Calibration and roleplay require explicit modes. Actual receipts, including interrupted runs after restart, are shown in the agent panel.

## Imports and Google indexes

The import panel requires the author's pseudonym and series name before reading uploaded files. Sources and all native import stages run in an isolated job vault. A usable base requires complete source coverage, all nine analysis layers, native machine checks, and a real independent reviewer receipt for the current candidate. Publishing is a separate explicit confirmation of the exact file manifest; an existing series is never overwritten. Large source reads use explicit ranges and report their completeness.

Google Docs keeps its separately authorized native suggestion/comment pipeline. Linked Sheets indexes use bounded A1 ranges with exact before-values and readback. Writing to Sheets requires optional additional Google consent; it does not invalidate the existing Docs connection. Formula-bearing target ranges are rejected so the agent can narrow the update to text cells. Sheets has no atomic revision guard: the app checks before-values and the saved result, but another editor can race that check. An uncertain write is reconciled before any retry.

## External host capabilities

StoryArt uses a narrow adapter to the official bundled Codex App MCP plugin. The server must inherit its real desktop bridge and caller identity from Codex Desktop; a plain remote standalone server does not have that transport. Capability is enabled only after the actual tools and registered StoryArt project probe succeeds. Each request owns a dedicated StoryArt chat, durable request ID and selected-workspace binding. Corrections/read/wait reuse that owned chat; unknown creation outcomes are not blindly retried. The site displays only candidate paths reported by that chat and validated inside StoryArt generation folders. Visual QA, canon QA and author approval remain separate. No credentials or bridge identity are copied into app storage.

Independent code review uses a fresh native app-server `review/start` thread on Sol 6.1 medium after authoritative model resolution, complete supplied before/after JS/MJS/JSON, a host-computed diff and host syntax checks. It receives a bounded packet, no parent history or tools. Syntax checks are not project tests; the receipt explicitly identifies supplied-source provenance. The site exposes actual review results and delegation history without automatic repair. Gemini consultation still requires its separate installed adapter and saved authentication. Check the running host capability status and practical acceptance receipts.

## Knowledge map

The Knowledge view is a term hierarchy, not a file graph. The central root branches into World and Story; World contains Rules and Entities, while Story contains Plot and Characters with separate Main, Secondary and Crowd tiers. Native document heading levels supply nested terms. Original source files remain unchanged.

Select a term to read its definition, nested particulars and source versions in the adjacent nonmodal information panel. On narrow screens the panel follows the map. Known unambiguous terms in prose are navigation links: selecting one reveals its path and highlights the destination. Exact excerpts and historical versions stay separate; originals are unchanged. The expandable SVG retains its central root and already expanded branches, without pagination. The searchable list provides the same navigation. Dotted links mean literal mentions in definitions, not causal rules or containment; their source version remains available. Unresolved particulars follow confirmed branches.

Private derived indexes live in `.data/knowledge-outlines/<seriesId>.json`, outside author sources and public distributions. Build one with `python scripts/build_knowledge_outline.py --spec <private-source-spec.json> --output <index.json>` from the repository root. The spec names native source snapshots and explicit evidence-based placements; it is not a model-generated taxonomy. The runtime validates the index, relative source paths, Google Docs links, parent structure and book binding. Limits: 2 MiB per index and 1,000 nodes. A series without an index shows the author navigation scaffold; unassigned sources do not inherit another series' concepts.
