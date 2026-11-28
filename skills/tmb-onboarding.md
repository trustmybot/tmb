# Onboarding the project

`tmb init` asks nothing, so a project starts with its settings empty. The session start names each empty one, with what tmb found in the project.

## The base branch, the checks and the shared folders

These are yours to recommend; the Human gets no question for them.

1. Work out the base branch and the checks you recommend, from what tmb found and what you read of the project.
2. Name the shared folders from the repo's own toolchain: the folders its install step fills, such as `node_modules` or `.venv`, as paths inside the repo. Every task worktree links them from the main folder instead of installing again. tmb detects none, so an empty list leaves each worktree bare.
3. Apply them with `settings_set` before other work. In a workspace of several repos, each repo has its own base branch, checks and shared folders, set under `repos`. Then install the dependencies in the main folder, so the folders exist to link.
4. Show the Human what you applied, and remind them that `tmb onboard` can be run again at any time to change the settings, and that you change a value when they ask. In an unattended run, name each value you applied in your answer instead.

## The review mode

The review mode decides how many tokens the project uses, so it is the Human's choice alone.

- Ask for it among your onboarding questions, with your host's question tool, such as AskUserQuestion: one option per mode with what it costs, agile marked as recommended. Store their answer with `settings_set`.
- With no one to ask, leave it unset and say that `task_start` is refused until the Human runs `tmb onboard`.
- In a workspace of several repos, a repo can have a mode of its own, which only the Human chooses too. Store their answer as that repo's `review_mode` in `repos`, or `workspace` to make it follow the workspace's again. A repo with none follows the workspace's mode, and when the repos follow different modes, `task_start` names its repo.

## The project's areas

Once the code graph is built, propose the project's areas, as the tmb-code-graph-knowledge skill says.
