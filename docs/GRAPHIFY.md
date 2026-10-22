# Local Graphify code index

For complete engineering tasks measured in seconds rather than individual search calls, see [task-level tests](GRAPHIFY-TASK-TESTS.md). The original small lookup benchmark below is retained with its known-target baseline limitations.

This pilot uses Graphify as a local AST index for code navigation. It indexes only the release source in `plugin/scripts/*.py`, `tests/publication/*.py`, and `scripts/build_release.py`. It excludes vaults, prose and other documents, local `plugins/talewisp/` copies, the private export bridge, and generated files. The staged source and immutable index runs stay under the ignored `.agent/graphify-20261020/worker/indexes/` directory.

Install the pinned Graphify package in the project-local isolated environment. The `extract --code-only --no-cluster` path parses code locally and skips semantic model calls, document extraction, and cluster naming. The wrapper never invokes Graphify's `install`, `hook`, or global graph commands.

```powershell
python -m venv .agent/graphify-20261020/worker/venv
```

```powershell
.agent/graphify-20261020/worker/venv/Scripts/python.exe -m pip install graphifyy==0.9.92
```

Build and inspect the index through the repository wrapper:

```powershell
.agent/graphify-20261020/worker/venv/Scripts/python.exe scripts/graphify_code.py build
```

```powershell
.agent/graphify-20261020/worker/venv/Scripts/python.exe scripts/graphify_code.py status
```

```powershell
.agent/graphify-20261020/worker/venv/Scripts/python.exe scripts/graphify_code.py query "Where is the series base request handled?" --seed series_base_cli.py
```

Run the reproducible before/after pair on a fresh immutable snapshot:

```powershell
.agent/graphify-20261020/worker/venv/Scripts/python.exe scripts/graphify_benchmark.py
```

The benchmark resolves RTK from `PATH` or `~/.local/bin/rtk.exe`. If needed, pass `--rtk <path>`; it stops with an actionable error when RTK is unavailable and does not substitute another search tool.

Before each query, the wrapper compares SHA-256 hashes for every indexed source against the manifest. A changed, missing, or newly added allowlisted Python file requires a rebuild. It also rejects symbolic links and Windows reparse points in indexed sources or state paths. Each build creates a new run and publishes it through an atomic active-run pointer; old runs remain available as evidence. State-directory overrides are names under `.agent/graphify-20261020/worker/indexes/`. Graphify exit codes are propagated by `query`, and `status` requires both a fresh manifest and a graph. The extractor checks that the installed distribution is exactly `graphifyy==0.9.92`.

Use Graphify output to locate likely files and symbols, then inspect the original source before relying on behavior.

The benchmark is asymmetric: the `rg` baseline receives the known answer files from `spec["expected"]` and pre-tuned regular expressions. Q1 searches only `plugin/scripts/source_adapters.py` and `tests/publication/test_source_adapters.py` in one call. Q2 searches only `plugin/scripts/series_base_cli.py`, `plugin/scripts/series_import.py`, `plugin/scripts/talewisp_mcp.py`, and `tests/publication/test_publication.py` in two calls. The exact patterns are in `SEARCHES` in `scripts/graphify_benchmark.py`. Graphify receives each literal question and searches the whole 21-file graph with budget 500 and no `--seed`. File coverage counts matches from that predeclared expected set. This compares known-target lookup with whole-graph navigation; it does not compare blind discovery on equal inputs.

In these two asymmetric samples, Graphify took longer; Q1 returned 1/2 expected files within the budget and Q2 returned 4/4. These results do not establish which approach is better for general file discovery, agent-task time, or token usage. The benchmark records raw output characters only; the formats include different path prefixes, and character counts are not token counts.
