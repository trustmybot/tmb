# packaging

Templates for installing tmb through a package manager (trustmybot/tmb#89, Part 3). The design is in [INSTALL.md](../docs/architecture/INSTALL.md#package-managers).

| Template | Becomes | Pushed to |
|---|---|---|
| [homebrew/cask.rb](homebrew/cask.rb) | `Casks/tmb.rb`, `Casks/tmb@rc.rb`, `Casks/tmb@dev.rb` | The tap, `trustmybot/homebrew-tmb` |
| [scoop/manifest.json](scoop/manifest.json) | `bucket/tmb.json`, `bucket/tmb-rc.json`, `bucket/tmb-dev.json` | The bucket, `trustmybot/scoop-tmb` |
| [winget/](winget/) | `manifests/t/TrustMyBot/tmb[/RC or /Dev]/<version>/*.yaml` | Nothing: kept as the workflow run's artifact, for a pull request to `microsoft/winget-pkgs` |

[scripts/package-managers.ts](../scripts/package-managers.ts) fills in a template's `{{...}}` from a release's version and `SHA256SUMS`. [.github/workflows/package-managers.yml](../.github/workflows/package-managers.yml) runs it after each dev, rc and stable release, and can be run by hand for a published version.

To try a template locally:

```sh
curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/SHA256SUMS -o /tmp/SHA256SUMS
bun scripts/package-managers.ts render "$(curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/VERSION)" /tmp/SHA256SUMS /tmp/tmb-manifests
```

## What the Human sets up

Until these exist, the workflow skips the push with a notice and the release still succeeds.

1. A public repo `trustmybot/homebrew-tmb`, with one commit (a README is enough). Users then run `brew install --cask trustmybot/tmb/tmb` (or `tmb@rc`, `tmb@dev`).
2. A public repo `trustmybot/scoop-tmb`, with one commit. Users then run `scoop bucket add tmb https://github.com/trustmybot/scoop-tmb` and `scoop install tmb/tmb` (or `tmb-rc`, `tmb-dev`).
3. A secret `TMB_PACKAGING_TOKEN` on `trustmybot/tmb`: a fine-grained token with Contents read and write on those two repos only.
4. A submission to winget's list: a pull request to `microsoft/winget-pkgs` with the manifests from a stable run's artifact, and the same for rc. Later versions can be submitted the same way.
