# Install tests

The published compiled file, downloaded and started on a clean machine. They run after each rc or stable release, on macOS, Windows and Linux ([all layers](../README.md)).

| Test | Run | What it proves |
|---|---|---|
| [smoke.ts](smoke.ts) | `bun run test:install [channel] [version]` | The installer of each channel installs the release it should. |
| [update.ts](update.ts) | `bun run test:install:update <channel>` | An older install on the channel, in a throwaway HOME, updates itself to the channel's newest release from the real release repo: the build is kept at a session's start, `tmb update` waits while a session runs, nothing swaps at a session's end while a task is open, `tmb update` then names the open task that holds it back, and the next session's end with no task open swaps it in. |
| [channels.ts](channels.ts) | `bun run test:install:channels` | The published installer puts `tmb`, `tmb-rc` and `tmb-dev` side by side in one throwaway home; each reports its own channel, looks for updates only there, keeps its own state and leaves the others' files alone. |

- A channel with no release yet is skipped.
- Install through a package manager is not supported yet, so a tap install and a bucket install are not tested (trustmybot/tmb#91).
