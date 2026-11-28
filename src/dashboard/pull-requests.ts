// The features page shows each feature's pull request as GitHub has it now: before a read, features
// whose pull request merged or closed are moved, as the Human, each asked about at most once a minute.
import { type Actor, type PullRequestReader, refreshPullRequestStates, type Store } from "../engine/index.ts";
import { PULL_REQUEST_READ_INTERVAL_MS } from "./constants.ts";

export class PullRequestRefresher {
  private readonly lastRead = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly actor: Actor,
    private readonly projectDir: string,
    private readonly read?: PullRequestReader,
  ) {}

  refresh(): void {
    refreshPullRequestStates(this.store, this.actor, this.projectDir, {
      read: this.read,
      shouldRead: (feature) => {
        const now = Date.now();
        if (now - (this.lastRead.get(feature.id) ?? -Infinity) < PULL_REQUEST_READ_INTERVAL_MS) return false;
        this.lastRead.set(feature.id, now);
        return true;
      },
    });
  }
}
