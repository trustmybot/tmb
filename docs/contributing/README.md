# Contributing

How work on this repo is done.

## Branches

- `dev` is the base branch and the default. Every change reaches it through a pull request.
- `main` holds releases only.
- Release tags start with `v`.

## Commits and pull requests

- Commit subjects follow Conventional Commits with a type emoji in front: 🐛 bug, ✨ feature, ⚡ improvement, 📝 docs, 🔧 chore, ✅ test, 🔬 research.
- Pull requests are squash-merged.
- Everything in the repo, its issues and its pull requests is written in English.

## CI

CI is split so that it never slows a lane down (trustmybot/tmb#164).

- **Pull requests and pushes to `dev` run only the fast Linux `test` job:** typecheck, `bun test` and the link lint. It is the one required check. The one exception is `install-smoke`, which runs on a pull request that changes the install smoke test itself.
- **Version tags (`vX.Y.Z-rc.N` and `vX.Y.Z`) run the heavy jobs:** `update-scenario` on macOS and Windows, `packaging-probe` on macOS, Linux and Windows, and the release build and install tests.
- **`dev-release.yml` builds and publishes the dev channel after each merge to `dev`.** It runs after the merge and blocks no one.
- **A macOS or Windows break shows up in the dev build or at the rc tag, not on the pull request.** That is the trade-off taken for speed. `packaging-probe` can also be run by hand from the Actions tab.
- **An rc is made from `dev` only after the whole chain passes on the Human's own machine** (the Human's rule, 2026-11-20). The Human runs it, with their own login, in the container and with the session steps: see [the whole chain in a container](../../tests/README.md#the-whole-chain-in-a-container). The run on GitHub comes after the local one, never in its place. There is no rc branch: an rc is the `vX.Y.Z-rc.N` tag, so the rule holds before that tag is pushed.

## Docs first

The design in [docs/architecture](../architecture/README.md) is the ground truth. Code follows it. When code and docs disagree, the question goes to the Human before either is changed.

## Issues

- **An issue is opened through a form.** The forms are in `.github/ISSUE_TEMPLATE`: bug report, feature request, improvement and research. A security problem is never an issue: see `SECURITY.md` at the root.
- **A form sets the type and marks the issue for triage.** It adds one `type/` label and `status/needs-triage`. Someone who cannot write to the repo cannot add labels, so the form does it.
- **A maintainer finishes the labels.** Every issue carries one `type/`, one `priority/` and one `area/` label. The area a reporter picks in the form is a guess; the maintainer sets the label, then removes `status/needs-triage` and sets the milestone.
- **A bug report names the version.** The form asks for what `tmb --version` prints, which names the channel too.
- **The forms are the one place the rules for a report live.** `tmb feedback` fills in the bug form as it stands on the default branch, so a change to the form changes what tmb reports (trustmybot/tmb#122). A workflow, `.github/workflows/feedback-labels.yml`, adds the form's labels to a report that `tmb feedback` filed through GitHub's CLI.
- **A field's `id` in a form is kept.** `tmb feedback` fills fields by their `id`. A field may be added or removed; one that stays keeps its `id`.
