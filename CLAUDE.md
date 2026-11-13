# TaleWisp: how Claude sessions work here

## Roles

The main session is the architect. It owns the goal, the design, the task breakdown, acceptance and integration, and it talks to the author. It does not hand those off.

Implementation that can be stated as a closed task goes to a subagent on a cheaper model. The project agents live in `.claude/agents/`:

| Agent | Model | Use it for |
| --- | --- | --- |
| `implementer` | Sonnet | One well-specified code change with a stated outcome and check |
| `test-runner` | Haiku | Running the suites and grouping failures; changes nothing |
| `diff-reviewer` | Sonnet | Reviewing a finished diff against its brief, when the author asks or before a risky step |

Built-in `Explore` covers wide read-only searches.

## When to delegate

Delegate when the task has a clear boundary (files or module), an outcome that can be checked, and does not need the conversation so far. Keep in the main session: decisions about design or scope, anything the author is still shaping, changes of a few lines, and work where each step depends on the previous answer.

Independent tasks run in parallel, one writer per set of files. Dependent tasks run in sequence. For parallel writers give each `isolation: worktree` or disjoint files.

## The brief

A subagent sees only its definition and the brief. Every brief states:

1. The goal and what it is for.
2. The exact files or area, and what must not be touched.
3. What done looks like, as checks the subagent can run.
4. What to return: changed files, check results with numbers, and what was verified versus assumed.
5. What to do when blocked: stop and report, never guess or widen the scope.

## Accepting the result

A subagent's report is a claim. Before telling the author something is done, read the actual diff and rerun or inspect the decisive check. A failed or partial result goes back to the same subagent with the specific gap, not to a new one.

## Tests

```sh
node web-client/scripts/prepare-test-fixtures.mjs
cd web-client
node --test --test-timeout=120000 "tests/*.test.mjs" "newtests/*.test.mjs" "tests-ui/*.test.mjs" "tests-agent/*.test.mjs" "tests-google/*.test.mjs"
python -m pytest -q -p no:cacheprovider tests
```

The second command runs from `web-client`, the last one from the repository root. Requires Node 24 or newer.

## Boundaries

- Author data (`vault/`, manuscripts, `.talewisp/`, `web-client/.data/`) is private: never commit it, never put it in a brief that leaves the machine without the author asking.
- Canon and author text change only on the author's explicit instruction.
- Commit messages are in English, in the style of the existing history.
