# Contributing

How work on this repo is done.

## Branches

- `dev` is the working branch and the default. Every change reaches it through a pull request.
- `main` holds releases only.
- Release tags start with `v`.

## Commits and pull requests

- Commit subjects follow Conventional Commits with a type emoji in front: 🐛 bug, ✨ feature, ⚡ improvement, 📝 docs, 🔧 chore, ✅ test, 🔬 research.
- Pull requests are squash-merged.
- Everything in the repo, its issues and its pull requests is written in English.

## Docs first

The design in [docs/architecture](../architecture/README.md) is the ground truth. Code follows it. When code and docs disagree, the question goes to the Human before either is changed.
