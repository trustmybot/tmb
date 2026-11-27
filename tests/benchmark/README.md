# Code graph benchmark

The code graph's scores on public repos, each at a fixed commit and against its language's own tool ([all layers](../README.md)).

| Test | Run | What it proves |
|---|---|---|
| [run.ts](run.ts) | `bun run test:benchmark` | tmb, hono, flask and datasette: functions found, links right, links found (against the reference, the score of record; and from the call states, shown only) and calls accounted for, per way, with the missing links by cause. |
| [score.test.ts](score.test.ts), [reference.test.ts](reference.test.ts), [repos.test.ts](repos.test.ts), [decorators.test.ts](decorators.test.ts) | `bun test` | The benchmark's arithmetic: each score as the code graph's design defines it, every repo at a fixed commit, a decorator's call owned by what encloses the decorated thing, an enforced stored score that falls fails, and a way not built has no score rather than a zero; Python's own parser and the TypeScript compiler, as references, on small fixtures. |
| [python-links.test.ts](python-links.test.ts) | `bun test` | Way B's Python links, judged by Jedi. |

## Stored scores

- `--check` fails when an enforced score stored in [scores.json](scores.json) falls. It runs on version tags in CI.
- `--write` alone writes that file, and refuses when a score fell.
- tmb's own pin is read from its history and moves only in a pull request that runs `--write`.
- A pull request that raises a score shows the run's output.

## Pinned repos and tools

- The benchmark never uses the network and never skips a repo: a missing copy fails it.
- `bun tests/lib/pinned-repo.ts` fetches hono; `bun tests/lib/pinned-repo.ts flask` and `bun tests/lib/pinned-repo.ts datasette` fetch the other two. `TMB_PINNED_FLASK` and `TMB_PINNED_DATASETTE` name another copy.
- The test setup installs Jedi at its pin and runs it with Python 3.10 or later: `TMB_JUDGE_PYTHON` names that interpreter, else `python3` on the path is used. With no such interpreter the Jedi tests are skipped and say so; the benchmark fails.
