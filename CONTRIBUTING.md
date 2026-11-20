# Contributing to tmb

Thanks for your interest. tmb is source available under the [Functional Source License](LICENSE.md). It is not open source.

## Before you start

- **Report a bug or ask for a feature** by opening an issue. Say which version you run (`tmb --version`), your OS, the command you ran and what it printed.
- **Open an issue before a pull request** for anything beyond a small fix, so the change is agreed before you write it.
- **Report a security problem privately**, never in an issue. See [SECURITY.md](SECURITY.md).

## Pull requests

- Branch from `dev` and open the pull request against `dev`.
- Commit subjects follow Conventional Commits with a type emoji in front: 🐛 bug, ✨ feature, ⚡ improvement, 📝 docs, 🔧 chore, ✅ test, 🔬 research.
- Run the checks before you push: `bun install`, then `bun test`, `bun run typecheck` and `bun run lint:links`.
- Pull requests are squash-merged.
- Write in English.

The design in [docs/architecture](docs/architecture/README.md) is the ground truth. Code follows it, so a change in behaviour starts with a change to the design. The house rules are in [docs/contributing](docs/contributing/README.md).
