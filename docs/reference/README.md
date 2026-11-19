# Reference

Install, upgrade and configuration.

## Install

The dev channel holds a build of every merge to the base branch. The install needs no login.

macOS and Linux:

```sh
curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh | sh
```

Windows, in PowerShell:

```powershell
irm https://github.com/trustmybot/tmb-releases/releases/download/dev/install.ps1 | iex
```

The script downloads the file for your platform, checks it against the published checksums, refuses to install on a mismatch, and puts tmb in `~/.local/bin` (Windows: `%USERPROFILE%\.local\bin`), the folder Claude Code also installs to. If that folder is not on your PATH, the script adds it to your shell profile (Windows: your user PATH) and says where; open a new terminal afterwards. Set `TMB_NO_MODIFY_PATH=1` to skip that and have it print the line to add instead. Run the same command again to upgrade.

Earlier builds installed to `~/.tmb/bin` (Windows: `%LOCALAPPDATA%\tmb\bin`). The script removes that old copy; run `tmb setup` again in any project you set up with it.

`tmb --version` prints the version and the source commit it was built from. Dev builds print a version of the form `X.Y.Z-dev.<n>.gh<PR>`, where `<n>` counts the commits since the last stable release and `<PR>` is the pull request that brought in the build's commit.

## Set up a project

In the project's root folder:

```sh
tmb setup
```

It asks no questions. For Claude Code it adds one SessionStart hook to `.claude/settings.local.json`, the project settings file that is yours alone, and keeps everything else in that file. The hook runs `tmb hook session-start`, which starts each session with the planner role. In a git work tree that does not ignore that file yet, setup adds it to `.gitignore`. Running setup again changes nothing.

## Remove

```sh
tmb remove
```

It removes only the hook setup added and leaves the rest of the settings file as it was. It does not remove the `.gitignore` line.
