// Feature branches: a milestone's work, cut from the base branch, that its tasks fold into.
import type { Actor } from "./actor.ts";
import { type EntryDetail, type EventLog, actorOf } from "./event-log.ts";

export type NewFeature = { name: string; baseBranch: string; baseCommit: string; repo?: string | null };
export type FeatureChanges = { state?: string; prUrl?: string | null; dropReason?: string | null; baseMergedCommit?: string | null };
export type Feature = {
  id: string;
  name: string;
  baseBranch: string;
  baseCommit: string;
  state: string;
  /** The pull request the engine opened for it; null until then. */
  prUrl: string | null;
  /** The repo the feature branch was cut in, by its name in the workspace; null for the project folder itself. */
  repo: string | null;
  /** Why the feature branch was dropped; null unless it is. */
  dropReason: string | null;
  /** The base branch's commit last brought into the branch; null until one is. */
  baseMergedCommit: string | null;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
};

type FeatureRow = {
  id: string;
  name: string;
  base_branch: string;
  base_commit: string;
  state: string;
  pr_url: string | null;
  repo?: string | null;
  drop_reason?: string | null;
  base_merged_commit?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

function toFeature(row: FeatureRow): Feature {
  return {
    id: row.id,
    name: row.name,
    baseBranch: row.base_branch,
    baseCommit: row.base_commit,
    state: row.state,
    prUrl: row.pr_url,
    repo: row.repo ?? null,
    dropReason: row.drop_reason ?? null,
    baseMergedCommit: row.base_merged_commit ?? null,
    createdBy: actorOf(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class FeatureRepository {
  constructor(private readonly log: EventLog) {}

  createFeature(actor: Actor, feature: NewFeature): string {
    return this.log.create(actor, "feature", { name: feature.name, base_branch: feature.baseBranch, base_commit: feature.baseCommit, repo: feature.repo ?? null });
  }

  updateFeature(actor: Actor, id: string, changes: FeatureChanges, detail?: EntryDetail): void {
    // Only what changes: a key with no value would clear its column.
    this.log.update(actor, "feature", id, {
      ...detail,
      ...(changes.baseMergedCommit === undefined ? {} : { base_merged_commit: changes.baseMergedCommit }),
      ...(changes.state === undefined ? {} : { state: changes.state }),
      ...(changes.prUrl === undefined ? {} : { pr_url: changes.prUrl }),
      ...(changes.dropReason === undefined ? {} : { drop_reason: changes.dropReason }),
    });
  }

  getFeature(id: string): Feature | null {
    const row = this.log.db.query("SELECT * FROM features WHERE id = ?").get(id) as FeatureRow | null;
    return row ? toFeature(row) : null;
  }

  findFeature(name: string): Feature | null {
    const row = this.log.db.query("SELECT * FROM features WHERE name = ?").get(name) as FeatureRow | null;
    return row ? toFeature(row) : null;
  }

  /** Feature branches in one state, or in any state when none is given, oldest first. */
  listFeatures(state?: string): Feature[] {
    const rows = (
      state === undefined
        ? this.log.db.query("SELECT * FROM features ORDER BY id").all()
        : this.log.db.query("SELECT * FROM features WHERE state = ? ORDER BY id").all(state)
    ) as FeatureRow[];
    return rows.map(toFeature);
  }
}
