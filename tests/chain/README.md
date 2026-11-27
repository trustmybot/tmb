# The whole chain in a container

One story on one record, from install to a shipped demo app ([all layers](../README.md)).

| Run | Command |
|---|---|
| In the container, under Docker or Podman, as CI runs it | `bun run test:whole-chain:container` |
| On this machine, with no container, in a temp folder | `bun run test:whole-chain` |
| Either, with the session steps too | add `--with-model`; the login comes from `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in the environment, and `TMB_CHAIN_MODEL` picks the model (Claude Code's default when unset) |
| Either, from the state saved before step N, then on to the end | add `--from N` |
| Either, step N alone from its saved state | add `--only N` |

## What it is

- **One empty Linux container.** It holds git, bun and Claude Code, and no tmb. tmb is installed inside by its real install script, so install is the first step. GitHub is not reached: each repo's remote is a bare repo in the container, and a fake `gh` stands in for pull requests.
- **One demo app of three repos, kept with the tests** in [demo-app/](demo-app/) and built with fixed dates: one in TypeScript in agile mode, one in Python and bash in truest mode, and one with no remote. `expected.json` holds the graph counts it should index.
- **One chain of steps on one record,** from install, init, doctor, onboard and index to features asked for in new sessions, a review, a refused push, pull requests, an update and the dashboard. The runner is [run.ts](run.ts) and the steps are in [steps/](steps/). The chain stops at the first failed step.
- **A feature is done when the chain covers it.** Each new feature adds a step or a check, or its pull request says why not.

Not done yet (trustmybot/tmb#260): the [agent run](../agent-run/README.md) and [agent chain](../agent-chain/README.md) tests become steps of the chain. Until then they stay separate scripts, each with its own small project. Windows and macOS stay outside the chain.

## Steps

| Steps | Use a model | When they run |
|---|---|---|
| 0 to 4 (install, init, doctor, onboard, index), 9 (a push typed by hand), 15 (update), 16 (the dashboard's Code page), 17 (the end check) | No | In CI on every pull request. |
| 5 to 8 and 10 to 14 (the session steps) | Yes, with `--with-model` | On request in the `agent run` workflow, which needs the `CLAUDE_CODE_OAUTH_TOKEN` repository secret, or on a developer's machine with that login in the environment. |

- **A session step** is a real `claude -p` session as bro, a new session or the next turn of one, in tmb's unattended mode. Each prompt is in [prompts/](prompts/), in a user's words. The chain holds no scripted reply: in steps 6, 12 and 14 bro must start the work on its defaults without stopping to ask.
- **The fake `gh`** ([github.ts](github.ts)) opens and reads pull requests, keeping them beside the bare remotes. The Human's squash merge on "the site" is made in the bare repo with a `github:` reflog message, so the record check knows no push made it.
- **Tokens are printed after each session step:** bro's turns as Claude Code counted them, and each agent run from tmb's record. A step over its budget is reported, not failed.
- **Before `dev` becomes an rc** the Human runs the chain first on their own machine, in the container, with `--with-model` and their own login. Only after it passes there does it run on GitHub.

## Checks

Three checks run after every step:

1. Every command tmb printed names the program that ran. The chain runs tmb as `tmb-dev`, so a printed `tmb <command>` fails.
2. `tmb doctor` reports no failure.
3. The record is whole: every closed task has a run with an end and its tokens, a check and a review, and every push in git is one the record allowed.

- A docs task has no run of its own: the planner writes it, and the record does not keep the planner's runs yet (trustmybot/tmb#254).
- A repo with no checks has none to run.
- An agile task's review is its feature branch's, due once the branch is past its review.

Each check prints PASS or FAIL. A check that fails because of a tmb bug already filed prints KNOWN with the issue and does not fail the step; once the bug is fixed it prints FIXED, and its mark is taken out. Logs of every step stay in the work folder's `logs`.

## Saved states

The chain saves a state before every step, in the work folder's `states`, as `before-step-NN.tar.gz` with an `index.json` that says which steps each is the outcome of.

- A state holds the HOME with tmb installed, the project with its record, and the bare remotes.
- Its paths are absolute, so it opens only in a work folder at the path it was saved in; the container's is always `/out/work`.
- On opening, the build under test replaces the tmb the state was saved with, as an update would. A newer tmb opens an older state through its normal upgrade of the record.
- A step run alone from its state uses the same prompt and the same checks. When a step fails in the chain and passes alone, the fault is in an earlier step's output.
- CI keeps the states of the last passing run on `dev` as the `chain-states` artifact of that run, for 30 days. They are not in git.

To run step N alone from CI's states:

```bash
gh run download <run-id> --repo trustmybot/tmb --name chain-states --dir ~/.cache/tmb-chain/ci/work/states
```

```bash
bun tests/chain/container.ts --out ~/.cache/tmb-chain/ci --only N
```
