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

## Docs first

The design in [docs/architecture](../architecture/README.md) is the ground truth. Code follows it. When code and docs disagree, the question goes to the Human before either is changed.

## Issues

- **An issue is opened through a form.** The forms are in `.github/ISSUE_TEMPLATE`: bug report, feature request, improvement and research. A security problem is never an issue: see [SECURITY.md](../../SECURITY.md).
- **A form sets the type and marks the issue for triage.** It adds one `type/` label and `status/needs-triage`. Someone who cannot write to the repo cannot add labels, so the form does it.
- **A maintainer finishes the labels.** Every issue carries one `type/`, one `priority/` and one `area/` label. The area a reporter picks in the form is a guess; the maintainer sets the label, then removes `status/needs-triage` and sets the milestone.
- **A bug report names the version.** The form asks for what `tmb --version` prints, which names the channel too.
- **The forms are the one place the rules for a report live.** `tmb feedback` fills in the bug form as it stands on the default branch, so a change to the form changes what tmb reports (trustmybot/tmb#122, planned for v1.0.0).
- **A field's `id` in a form is kept.** `tmb feedback` fills fields by their `id`. A field may be added or removed; one that stays keeps its `id`.
